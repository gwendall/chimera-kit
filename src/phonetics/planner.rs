//! Segment sequence → gestural score. Timing and phonation are articulatory: aspiration is a
//! glottal opening gesture peaking at the release (VOT emerges), nasality is velum lowering with
//! anticipation, coarticulation comes from overlapping vowel gestures beneath consonant gestures.
//!
//! The planners allocate and run off the audio thread. [`oral_gestures_into`] (used by the beat
//! sequencer) builds into a caller's `Vec` and allocates nothing once it has capacity.

use super::durations::{SegInfo, klatt_durations};
use super::inventory::{Glottal, Manner, PhonemeDef, VOICELESS_H, Voicing, phoneme};
use super::{Intonation, Plan, PlannedSegment, Segment};
use crate::anatomy::human::{ArticKey, ArticPatch, BodyMix, BodyName};
use crate::control::score::{ControlKey, Gesture, Targets};
use crate::math::{js_max, js_min, js_round, sqrt};
use crate::sources::glottis::{REGISTER_PITCH, threshold_rise};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// label of the end-of-breath-group abduction (a live note can drop it when the next one starts)
pub const EXHALE_LABEL: &str = "exhale";

/// when a sung phrase's breath reaches full drive, after the plan start (its first segment starts at 0.06)
const BREATH_SUNG_AT: f64 = 0.06;

const VOWEL_KEYS: [ArticKey; 9] = [ArticKey::TbX, ArticKey::TbY, ArticKey::Jaw, ArticKey::LipAp, ArticKey::LipProt, ArticKey::LipWidth, ArticKey::Root, ArticKey::Larynx, ArticKey::TtCurl];

/// One calibrated vowel of `vowelTargets.generated.json`.
#[derive(Clone, Debug, Deserialize)]
pub struct VowelTarget {
    pub artic: ArticPatch,
    #[serde(default)]
    pub formants: Vec<f64>,
}

/// body name → IPA → calibrated vowel
pub type VowelTable = BTreeMap<String, BTreeMap<String, VowelTarget>>;

/// The calibrated vowel table (parsed once).
pub fn vowel_table() -> &'static VowelTable {
    static T: OnceLock<VowelTable> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("vowelTargets.generated.json")).expect("vowelTargets.generated.json"))
}

/// Diphthongs and r-coloured vowels expand to vowel sequences. American /eɪ oʊ/ glide toward
/// [i u] (Hillenbrand et al. 1995: /e/ F2 rises ~150 Hz, /o/ F1 falls with F2 steady); with
/// [ɪ ʊ] as targets they barely moved (/e/ and /ɪ/ share F2) and sounded like the steady
/// [eː oː] of Indian English. The other offglides undershoot toward [ɪ ʊ].
pub fn expand(ipa: &str) -> Option<&'static [&'static str]> {
    Some(match ipa {
        "aɪ" => &["a", "ɪ"],
        "aʊ" => &["a", "ʊ"],
        "ɔɪ" => &["ɔ", "ɪ"],
        "eɪ" => &["e", "i"],
        "oʊ" => &["o", "u"],
        "ɚ" => &["ɝ"],
        _ => return None,
    })
}

/// The two vowel targets of a diphthong ("aɪ" → ("a", "ɪ")), or None.
pub fn diphthong_parts(ipa: &str) -> Option<(&'static str, &'static str)> {
    match expand(ipa) {
        Some(p) if p.len() == 2 => Some((p[0], p[1])),
        _ => None,
    }
}

pub fn is_vowel(ipa: &str, body: BodyMix) -> bool {
    let t = vowel_table();
    body.weights().iter().any(|(b, w)| *w > 0.0 && t.get(b.as_str()).is_some_and(|t| t.contains_key(ipa))) || expand(ipa).is_some()
}

/// The calibrated articulation of a vowel for a body: between presets, the presets' calibrated
/// articulations blended by the body's weights.
pub fn vowel_artic(ipa: &str, body: BodyMix) -> Option<ArticPatch> {
    if let Some(b) = body.preset() {
        return preset_vowel_artic(ipa, b);
    }
    let w = body.weights();
    let mut parts = [(0.0, ArticPatch::default()); 3];
    for (i, (b, wi)) in w.iter().enumerate() {
        if *wi > 0.0 {
            parts[i] = (*wi, preset_vowel_artic(ipa, *b)?);
        }
    }
    Some(ArticPatch::blend(&parts))
}

fn preset_vowel_artic(ipa: &str, body: BodyName) -> Option<ArticPatch> {
    let t = vowel_table();
    let v = t.get(body.as_str()).and_then(|b| b.get(ipa)).or_else(|| t.get("male").and_then(|m| m.get(ipa)))?;
    let mut out = ArticPatch::default();
    for k in VOWEL_KEYS {
        if let Some(x) = v.artic.get(k) {
            out.set(k, x);
        }
    }
    // a rhotic's tip is raised and curled back, not resting behind the teeth: without its
    // calibrated position the tip stayed down and /ɝ/'s F3 sat ~15–20 % high (weakly rhotic)
    if v.artic.get(ArticKey::TtCurl).unwrap_or(0.0) > 0.05 {
        if let Some(x) = v.artic.get(ArticKey::TtX) {
            out.set(ArticKey::TtX, x);
        }
        if let Some(x) = v.artic.get(ArticKey::TtY) {
            out.set(ArticKey::TtY, x);
        }
    }
    Some(out)
}

/// Parse the vowel and consonant tables now (so nothing initialises lazily on the audio thread).
pub fn init() {
    vowel_table();
    super::inventory::init();
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOptions {
    pub body: BodyMix,
    /// voice-clock start time (s)
    pub t0: f64,
    /// speaking-rate multiplier (>1 = faster)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    /// baseline pitch (Hz)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f0: Option<f64>,
    /// "statement" (final fall) or "question" (final rise)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intonation: Option<Intonation>,
    /// pitch excursion for stressed syllables (fraction)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<f64>,
    /// the last segment is held open-ended (a sung note): no end-of-breath release
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_end: Option<bool>,
    /// a sung phrase (`plan_song`): consonants given a pitch hold it, and pitch ramps shrink to
    /// fit short notes. Speech and live notes leave it unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sung: Option<bool>,
    /// The segment times are measured acoustic boundaries (aligned phones, `chimera render
    /// aligned`): a vowel or voiced consonant starts where its voice does, so the opening of the
    /// folds for the consonant before it (/h/, voiceless, aspiration, ɦ) is released by that
    /// consonant's end (`closed_by`). A glottal stop keeps its planned closure, released 15 ms
    /// into the vowel: the hard attacks of the validated hiccups depend on it. Planned speech and
    /// songs leave it unset: their durations were tuned with the release running into the next
    /// segment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured: Option<bool>,
}

/// JS truthiness of an optional number (`if (s.f0)`: 0 and NaN are false).
#[inline]
pub(crate) fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

/// `Partial<HumanArtic>` as gesture targets
#[inline]
pub(crate) fn artic_targets(p: &ArticPatch) -> Targets {
    let mut t = Targets::default();
    for (k, x) in p.iter() {
        t.set(k, x);
    }
    t
}

#[inline]
fn one(k: impl Into<ControlKey>, x: f64) -> Targets {
    Targets::default().with(k, x)
}

/// A planner segment: the input segment plus what the planner attaches to it.
struct Seg<'a> {
    ipa: &'a str,
    dur: Option<f64>,
    stress: Option<u8>,
    f0: Option<f64>,
    def: Option<PhonemeDef>,
    vowel: Option<ArticPatch>,
    glide_from: bool,
    /// the last segment of a word (text input marks word ends; aligned phones don't)
    word_end: bool,
}

#[derive(Clone, Copy)]
struct Span {
    t0: f64,
    t1: f64,
}

pub fn plan_utterance(input: &[Segment], o: &PlanOptions) -> Plan {
    let rate = o.rate.unwrap_or(1.0);
    let body = o.body;
    // durations by the Klatt rules, on whole segments (diphthongs before they are split)
    let durs = klatt_durations(input, |s| {
        if is_vowel(&s.ipa, body) {
            return SegInfo { vowel: true, ..Default::default() };
        }
        let d = phoneme(&s.ipa, body);
        SegInfo { vowel: false, manner: d.map(|d| d.manner), voiced: Some(d.is_some_and(|d| d.voicing == Voicing::Voiced)), dur: d.map(|d| d.dur) }
    });
    // expand diphthongs into two vowel targets sharing the duration
    let mut segs: Vec<Seg> = Vec::with_capacity(input.len() + 4);
    for (si, s) in input.iter().enumerate() {
        if let Some(parts) = expand(&s.ipa) {
            let base = durs[si];
            for (i, p) in parts.iter().enumerate() {
                let dur = if parts.len() > 1 { base * (if i == 0 { 0.55 } else { 0.45 }) } else { base };
                segs.push(Seg { ipa: p, dur: Some(dur), stress: s.stress, f0: s.f0, def: None, vowel: None, glide_from: i > 0, word_end: i == parts.len() - 1 && s.word_end == Some(true) });
            }
        } else {
            segs.push(Seg { ipa: &s.ipa, dur: Some(durs[si]), stress: s.stress, f0: s.f0, def: None, vowel: None, glide_from: false, word_end: s.word_end == Some(true) });
        }
    }
    for s in segs.iter_mut() {
        let v = vowel_artic(s.ipa, body);
        if v.is_some() {
            s.vowel = v;
        } else {
            s.def = phoneme(s.ipa, body);
        }
    }
    let mut gestures: Vec<Gesture> = Vec::new();
    let mut planned: Vec<PlannedSegment> = Vec::with_capacity(segs.len());
    let mut t = o.t0 + 0.06; // breath onset lead
    let mut times: Vec<Span> = Vec::with_capacity(segs.len());
    for s in &segs {
        let mut d = if let Some(d) = s.dur {
            d
        } else if s.vowel.is_some() {
            if s.stress == Some(1) {
                0.17
            } else if s.stress == Some(2) {
                0.13
            } else {
                0.095
            }
        } else {
            s.def.map_or(0.08, |d| d.dur)
        };
        // final lengthening on the last syllable rhyme
        d /= rate;
        times.push(Span { t0: t, t1: t + d });
        t += d;
    }
    let end = t;
    // ---- vowel gestures: overlap neighbours so the tongue travels vowel-to-vowel
    let v_idx: Vec<usize> = segs.iter().enumerate().filter(|(_, s)| s.vowel.is_some()).map(|(i, _)| i).collect();
    for (n, &i) in v_idx.iter().enumerate() {
        let prev = if n > 0 { times[v_idx[n - 1]].t1 } else { times[i].t0 - 0.08 };
        let next = if n < v_idx.len() - 1 { times[v_idx[n + 1]].t0 } else { times[i].t1 + 0.08 };
        // vowel-to-vowel through the consonant (Öhman): the previous vowel lets go early in the gap
        // and the next one's target ramps in over most of it, so the tongue body is already near
        // the next vowel at the release and the transitions carry the consonant's place
        let r_in = js_max(0.03, 0.75 * (times[i].t0 - prev)) + 0.01;
        let r_out = js_max(0.03, 0.4 * (next - times[i].t1)) + 0.01;
        gestures.push(Gesture::new(times[i].t0, times[i].t1, r_in, r_out, 1.0, artic_targets(segs[i].vowel.as_ref().unwrap())).label(segs[i].ipa));
    }
    // utterance-initial/final consonants: lend them the nearest vowel's body posture
    // ---- consonant gestures
    for (i, s) in segs.iter().enumerate() {
        let Span { t0, t1 } = times[i];
        let dur = t1 - t0;
        planned.push(PlannedSegment {
            ipa: s.ipa.to_string(),
            t0,
            t1,
            stress: if s.vowel.is_some() { Some(s.stress.unwrap_or(0)) } else { None },
            kind: if s.vowel.is_some() { "vowel".to_string() } else { s.def.map_or("?", |d| d.manner.as_str()).to_string() },
        });
        let Some(def) = s.def.as_ref() else { continue };
        let next_vowel = i < segs.len() - 1 && segs[i + 1].vowel.is_some();
        let prev_seg = if i > 0 { Some(&segs[i - 1]) } else { None };
        // the vowel a voiced closure makes its room from (the one before it, else after) and its height
        let ctx_vowel = segs[..i].iter().rev().chain(&segs[i + 1..]).find_map(|s| s.vowel.as_ref());
        let height = ctx_vowel.map_or(0.0, |v| vowel_height(v, body));
        // (only straight from the vowel: after a consonant the articulator starts elsewhere)
        let voice_bar_stop = def.voicing == Voicing::Voiced && !def.dominant.contains(&ArticKey::TbY) && height > 0.0 && prev_seg.is_some_and(|s| s.vowel.is_some());
        // a short /d/ from a stressed vowel into an unstressed one ("body", "ready"), see FLAP_MAX
        let flap = def.voicing == Voicing::Voiced
            && def.dominant.contains(&ArticKey::TtY)
            && dur < FLAP_MAX
            && prev_seg.is_some_and(|s| s.vowel.is_some() && matches!(s.stress, Some(1 | 2)))
            && segs.get(i + 1).is_some_and(|s| s.vowel.is_some() && !matches!(s.stress, Some(1 | 2)));
        // a voiced stop released into a vowel is released before its span ends (RELEASE_LAG): its
        // closure, and the room behind it, end there
        let t1 = if def.manner == Manner::Stop && def.voicing == Voicing::Voiced && next_vowel { t1 - release_lag(def, dur) } else { t1 };
        let mut add_oral = |tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str| oral_gestures_into(def, tg, a, b, speed, label, &mut gestures);
        match def.manner {
            // a stop that closes behind another stop's closure, its articulator already placed by
            // the segment before that (the tip raised for /ɹ/ in "sharp tree"), reaches contact
            // sooner than from a vowel: with the usual lead it sealed ~20 ms before the front
            // closure opened, and the tongue then pumped the air shut between the two closures
            // The delay leaves the closure 30 ms before its release (its 10 ms minimum hold and
            // its ~20 ms early release), so a short sung stop isn't pushed past its own end.
            Manner::Stop if pre_placed_behind_closure(&segs, i) => add_oral(&def.targets, t0 + js_min(PLACED_CLOSURE_DELAY, js_max(0.0, dur - 0.03)), t1, 1.55, def.ipa),
            // A front closure must not seal a pocket while the preceding back closure is
            // still releasing. Its shorter travel can otherwise seal the lips several ms
            // before the tongue lets go, compressing the trapped air (as in /d p/).
            Manner::Stop if prev_seg.and_then(|s| s.def).is_some_and(|p| p.manner == Manner::Stop && closes_in_front(def.place, p.place)) =>
                add_oral(&def.targets, t0 + js_min(0.01, js_max(0.0, dur - 0.03)), t1, 1.55, def.ipa),
            // a flapped /d/: the tip starts later the shorter its span (FLAP_LATE), on top of the
            // high vowel's delay below
            Manner::Stop if flap => {
                let high = if voice_bar_stop { HIGH_LATE * height } else { 0.0 };
                late_oral_gestures_into(def, &def.targets, t0, t1, 1.55, def.ipa, high + FLAP_LATE * (FLAP_MAX - dur), &mut gestures)
            }
            // after a high vowel the lips or the tip start close to their target: with the usual
            // early onset /d/ sealed 18 ms early, held 80 ms, and the voice stopped (see voice_bar)
            Manner::Stop if voice_bar_stop => late_oral_gestures_into(def, &def.targets, t0, t1, 1.55, def.ipa, HIGH_LATE * height, &mut gestures),
            Manner::Stop | Manner::Nasal => add_oral(&def.targets, t0, t1, 1.55, def.ipa),
            // a tap is one brief contact, not a closure over the aligned span: over the whole span
            // the tongue sealed for 42 ms, 36 ms late, and a sung a-ɾ-a fell silent (41 to 71 dB)
            Manner::Tap => {
                let (a, b) = tap_contact(t0, t1);
                add_oral(&def.targets, a, b, 2.8, def.ipa)
            }
            Manner::Trill => {
                // driven trill: rapid alternation of near-closure and release at ~26 Hz
                let n = js_max(2.0, js_round(dur * 26.0));
                let mut k = 0.0;
                while k < n {
                    let a = t0 + (k / n) * dur;
                    add_oral(&def.targets, a, a + 0.35 / 26.0, 3.2, def.ipa);
                    k += 1.0;
                }
            }
            Manner::Affricate => {
                let split = t0 + dur * 0.55;
                add_oral(&def.targets, t0, split, 2.0, def.ipa);
                let rel = def.release.and_then(|r| phoneme(r, body));
                if let Some(rel) = rel {
                    add_oral(&rel.targets, split + 0.008, t1, 1.4, def.ipa);
                }
            }
            Manner::Fricative | Manner::Approximant | Manner::Lateral => add_oral(&def.targets, t0, t1, 1.3, def.ipa),
            Manner::Glottal | Manner::Vowel => {}
        }
        if def.voicing == Voicing::Voiced && matches!(def.manner, Manner::Stop | Manner::Tap | Manner::Affricate) {
            let (a, b) = match def.manner {
                // the tongue touches about TAP_LEAD after its gesture starts: the room is made then
                Manner::Tap => {
                    let (a, b) = tap_contact(t0, t1);
                    (a + TAP_LEAD, b + TAP_LEAD)
                }
                Manner::Affricate => (t0, t0 + dur * 0.55),
                _ => (t0, t1),
            };
            if let Some(v) = ctx_vowel {
                gestures.push(voice_bar(def, v, height, closure_push(&segs, i, o.f0.unwrap_or(110.0), body), a, b));
            }
        }
        // nasality: the velum lowers in anticipation (into the preceding vowel, as in English) and
        // seals again by the end of the nasal; 0.45 cm² is ample for the murmur
        if def.nasal == Some(true) {
            gestures.push(Gesture::new(t0 - 0.02, t1 - 0.02, 0.05, 0.03, 4.0, one(ArticKey::Velum, 0.45)).label("velum"));
        }
        // phonation
        let k2 = 1.0; // abduction is body-scaled in the voice
        let glottal = match def.glottal {
            Some(Glottal::Open) if segs[i].ipa != VOICELESS_H && between_voiced(&segs, i) => Some(Glottal::Breathy),
            g => g,
        };
        // measured boundaries: the voice of the segment after this one starts at this one's end
        // (a glottal stop is not passed through `release`: see `PlanOptions::measured`)
        let measured_release = o.measured == Some(true) && segs.get(i + 1).is_some_and(voiced_seg);
        let release = |g: Gesture| if measured_release { closed_by(g, t0, t1) } else { g };
        if glottal == Some(Glottal::Open) {
            gestures.push(release(Gesture::new(t0 - 0.01, t1, 0.03, 0.035, 5.0, one(ControlKey::ABDUCTION, 0.33 * k2)).label("h")));
        } else if glottal == Some(Glottal::Breathy) {
            gestures.push(release(Gesture::new(t0, t1, 0.03, 0.03, 5.0, one(ControlKey::ABDUCTION, BREATHY_ABDUCTION * k2)).label("ɦ")));
        } else if glottal == Some(Glottal::Stop) {
            // as planned on measured boundaries too: released inside its span, a 20 ms ʔ after a
            // silence voiced its vowel from its t0 instead of 15 ms later, on the lead (20 ms
            // advance) inside the ʔ, and moved a hiccup the founder validated (+1.67 dB)
            gestures.push(Gesture::new(t0, t1, 0.012, 0.015, 8.0, one(ControlKey::CLOSURE, 1.0)).label("ʔ"));
        } else if def.voicing == Voicing::Voiceless {
            if def.manner == Manner::Stop && unreleased_into_voiced(&segs, i) {
                // no opening: the folds stay together through the closure and voice the
                // consonant after it from its start
            } else if def.manner == Manner::Stop || def.manner == Manner::Affricate {
                // aspirated when syllable-initial before a vowel and not after /s/ (English-like)
                let aspirated = next_vowel && !prev_seg.is_some_and(|p| p.ipa == "s");
                let vot = if aspirated { 0.05 / rate } else { 0.012 };
                gestures.push(release(Gesture::new(t0 + 0.25 * dur, t1 + vot * 0.4, 0.035, if aspirated { 0.045 } else { 0.02 }, 6.0, one(ControlKey::ABDUCTION, if aspirated { 0.36 } else { 0.22 })).label("aspiration")));
            } else {
                gestures.push(release(Gesture::new(t0 - 0.015, t1 + 0.005, 0.03, 0.03, 6.0, one(ControlKey::ABDUCTION, 0.3)).label("voiceless")));
            }
        } else if def.manner == Manner::Fricative {
            gestures.push(Gesture::new(t0, t1, 0.03, 0.03, 3.0, one(ControlKey::ABDUCTION, 0.035)).label("voiced frication"));
        }
    }
    let open_end = o.open_end == Some(true);
    let sung = o.sung == Some(true);
    // ---- breath: on through the utterance. A sung phrase's onset is planned (its first vowel
    // lands on the beat), so a singer times the breath to it: the pressure reaches full drive as
    // the first segment starts, and builds into adducted folds or behind the first constriction
    // rather than voicing ahead of the note. Speech and live notes keep their 20 ms lead.
    let breath_at = if sung { BREATH_SUNG_AT } else { 0.04 };
    gestures.push(Gesture::new(o.t0 + breath_at, end, 0.04, if open_end { 0.07 } else { 0.05 }, 1.0, one(ControlKey::BREATH, 1.0)).label("breath"));
    // ---- end of the breath group: the folds part as the breath stops, so a final obstruent is
    // released into silence instead of into an added vowel ("cat-uh"). After a vowel or sonorant
    // they part once the pressure has fallen, so the voice fades out instead of ending in an [h].
    if !open_end {
        let last = segs.last();
        let sonorant = last.is_some_and(|l| l.vowel.is_some()) || last.and_then(|l| l.def).is_some_and(|d| matches!(d.manner, Manner::Nasal | Manner::Approximant | Manner::Lateral | Manner::Tap | Manner::Trill));
        let at = end + if sonorant { 0.045 } else { 0.015 };
        gestures.push(Gesture::new(at, end + 0.1, 0.03, 0.06, 6.0, one(ControlKey::ABDUCTION, 0.22)).label(EXHALE_LABEL));
    }
    // ---- intonation: pitch targets on vowels
    let f0 = o.f0.unwrap_or(110.0);
    let accent = o.accent.unwrap_or(0.14);
    let total = js_max(0.2, end - o.t0);
    // the nuclear accent: the phrase's last primary-stressed vowel, a bigger excursion that falls
    // (statements) into the final low; earlier accents are smaller (a "hat" pattern)
    let mut nuclear: isize = -1;
    for &i in &v_idx {
        if segs[i].stress == Some(1) && !segs[i].glide_from {
            nuclear = i as isize;
        }
    }
    for (n, &i) in v_idx.iter().enumerate() {
        let s = &segs[i];
        let Span { t0, t1 } = times[i];
        // pitch holds through the consonants up to the next vowel (instead of sagging to the base)
        let hold = if n < v_idx.len() - 1 { js_max(t1, times[v_idx[n + 1]].t0 - 0.03) } else { t1 };
        let mut target: f64;
        let has_f0 = truthy(s.f0);
        if has_f0 {
            target = s.f0.unwrap();
        } else {
            let prog = (t0 - o.t0) / total;
            let decl = 1.0 - 0.1 * prog;
            let is_nuclear = i as isize == nuclear;
            let acc = if s.stress == Some(1) {
                1.0 + (if is_nuclear { accent * 1.8 } else { accent })
            } else if s.stress == Some(2) {
                1.0 + accent * 0.5
            } else {
                1.0
            };
            target = f0 * decl * acc;
            let last = n == v_idx.len() - 1;
            if last && o.intonation == Some(Intonation::Question) {
                target = f0 * 1.35;
            }
            if last && o.intonation.unwrap_or(Intonation::Statement) == Intonation::Statement {
                if is_nuclear && t1 - t0 > 0.08 {
                    // accent peak early in the vowel, then the fall within it
                    gestures.push(Gesture::new(t0, t0 + 0.35 * (t1 - t0), 0.05, 0.05, 1.0, one(ControlKey::F0, target)).label("pitch"));
                    gestures.push(Gesture::new(t0 + 0.55 * (t1 - t0), t1, 0.06, 0.06, 1.0, one(ControlKey::F0, f0 * 0.82)).label("pitch"));
                    continue;
                }
                target = f0 * 0.82;
            }
        }
        let r = if has_f0 && sung { pitch_ramp(t1 - t0) } else { 0.06 };
        gestures.push(Gesture::new(t0, if has_f0 { t1 } else { hold }, r, r, if has_f0 { 6.0 } else { 1.0 }, one(ControlKey::F0, target)).label("pitch"));
    }
    // sung: a consonant given its note's pitch holds it, so the pitch moves during an onset
    // consonant and has arrived when the vowel starts
    for (i, s) in segs.iter().enumerate() {
        if sung && s.vowel.is_none() && truthy(s.f0) {
            let Span { t0, t1 } = times[i];
            let r = pitch_ramp(t1 - t0);
            gestures.push(Gesture::new(t0, t1, r, r, 6.0, one(ControlKey::F0, s.f0.unwrap())).label("pitch"));
        }
    }
    Plan { gestures, segments: planned, end }
}

/// A tap's contact: TAP_CONTACT long, centred TAP_LEAD before the middle of its span, so the
/// contact itself (which comes about TAP_LEAD after the gesture at speed 2.8) is centred in it.
const TAP_CONTACT: f64 = 0.02;
const TAP_LEAD: f64 = 0.02;

fn tap_contact(t0: f64, t1: f64) -> (f64, f64) {
    let c = 0.5 * (t0 + t1) - TAP_LEAD;
    let h = 0.5 * js_min(TAP_CONTACT, t1 - t0);
    (c - h, c + h)
}

/// The voice bar of a voiced closure. Sealed, the airway behind a closure fills with the
/// glottal flow until the drop across the glottis can no longer drive it: the yielding walls
/// alone kept /b/ voiced 31 ms, /d/ 6 ms, and a sung a-C-a fell 33 to 71 dB, where a voiced
/// closure keeps its voice (in TSP speech 17 to 40 dB under the vowel). Speakers make the room
/// actively during /b d g/ (Westbury 1983: larynx lowering, tongue-root advance, tongue-body
/// lowering).
///
/// The budget, in the human model: keeping 3.6 cmH2O across the glottis (where the voicing gate
/// is nearly open) through a 45 ms closure takes about 87 cm³/s, so 3.9 cm³. The walls
/// (0.5 cm³/cmH2O) take about 2.5 cm³ at 5 cmH2O, so the tract must grow 1.5 to 3 cm³. Measured
/// per cm behind the closure: TbY 11 cm³ (labial, alveolar), TbX 4 cm³ and Root 1.4 cm³
/// (velar), Larynx 1.4 to 2 cm³. Lowering the tongue body behind a closure the tongue body
/// makes (/g/, and /ɟ ɢ/) moves the closure itself, so that room comes from the body moving
/// forward and the root.
/// These add 3.3 cm³ (/b/), 5.3 cm³ (/d/, which also undoes the alveolar fronting gesture's
/// raised tongue body squeezing the pocket) and 3.9 cm³ (/g/). Sung at 220 and 440 Hz, /b d g ɾ/
/// stay voiced through the whole closure, 17 to 33 dB under the vowel.
const VOICE_BAR_STRENGTH: f64 = 8.0;
const VOICE_BAR: [(ArticKey, f64); 2] = [(ArticKey::TbY, -0.25), (ArticKey::Larynx, -0.3)];
const VOICE_BAR_VELAR: [(ArticKey, f64); 3] = [(ArticKey::TbX, 0.5), (ArticKey::Root, 0.5), (ArticKey::Larynx, -0.3)];


/// After a high vowel that room was not enough: from /i/ the tongue tip starts near the ridge
/// and the lips near each other, the early onset sealed /d/ 18 ms early and held it 80 ms, the
/// narrow approach had already built 7.3 of the 8.2 cmH2O behind it, and the voice stopped:
/// after /i e/ /d/ fell 60 to 92 dB, after /i/ /ɾ/ 61 to 70 dB and /g/ 27 to 36 dB. So, scaled
/// by the vowel's height h (0 at /a/, 1 at /i/, from the body's own tongue-body heights): /b d/
/// start closing HIGH_LATE·h later (the closure back to 50 ms), /g ɾ/ (and /ɟ ɢ/) make the
/// room HIGH_LEAD·h earlier, the tongue body drops HIGH_TBY·h and the larynx HIGH_LARYNX·h
/// more, at HIGH_STRENGTH·h more strength, and the room lets go HIGH_RAMP_OUT·h sooner so the
/// next vowel comes back sooner. Each part was needed: without the later onset /d/ still fell
/// 42 to 55 dB, without the extra drop /d ɾ/ 43 to 63 dB, without the tap's lead /ɾ/ 33 to 45
/// dB. Sung at 220 and 440 Hz after /i u e o/, /b d g ɾ dʒ/ stay voiced through the closure,
/// 14 to 34 dB under the vowel; /a/ is unchanged (h = 0).
const HIGH_LATE: f64 = 0.03;

/// A short /d/ from a stressed vowel into an unstressed one ("body", "ready", where American
/// English flaps it) is a brief tap of the tip, not a held closure. TSP's speakers dip it 24.0 dB
/// under 50 ms (30 pairs, 17.5 ms wide at half depth) and 28.7 dB from 50 to 80 ms (22 pairs,
/// 26.2 ms); the stop dipped 12.0 and 9.1 dB deeper, 27.5 and 37.5 ms wide. The tip starts
/// FLAP_LATE·(FLAP_MAX - span) later, so the shorter the span the briefer the contact (6.1 and
/// 6.6 dB deeper, 20 and 25 ms wide). Before a stressed vowel, and from FLAP_MAX on, the stop is
/// unchanged. /b/ there is left as is: shallower lips did not seal a 30 ms /b/ after /i eɪ/.
const FLAP_MAX: f64 = 0.08;
const FLAP_LATE: f64 = 0.5;
const HIGH_LEAD: f64 = 0.03;
const HIGH_TBY: f64 = -0.55;
const HIGH_LARYNX: f64 = -0.2;
const HIGH_STRENGTH: f64 = 12.0;
const HIGH_RAMP_OUT: f64 = -0.03;

/// How long before the end of its span a voiced stop released into a vowel is released (s), by
/// what makes the closure: the lips, the tip, the tongue body. An aligner ends the stop where the
/// next vowel is fully voiced, so the burst and the release transition are in the stop's span. In
/// TSP (vowel, /b d g/, vowel; 120, 120 and 86 pairs, 500 to 2500 Hz) the speakers' level comes
/// back within 15 dB of the vowels 13.5, 21.6 and 29.6 ms before the span's end (/d/ 17 ms in
/// spans under 45 ms, 24 ms over 90; /g/ 23 to 32 ms), the engine's, released on the boundary,
/// 0.3, 0.2 and 2.7 ms before it: its /g/ dip was half as wide again as the speakers' at half
/// depth (65 ms against 42) and its /d/ kept deepening to the boundary (the median curve 35 dB
/// under the vowels, the speakers' 26). Released RELEASE_LAG earlier, the three come back 13.0,
/// 21.4 and 30.1 ms before it, the /g/ dip is 50 ms wide and the /d/ curve 26 dB deep. The /g/
/// curve is now 26 dB deep where the speakers' is 33: the old depth came from the late release.
/// The lips keep their boundary: released 13 ms early, /b/ came back on time but its closure,
/// already shallower than the speakers' (pair median 37 dB against 40), dipped 34 dB, and Whisper
/// heard the sung /b/ as a glide ("was Billie" as "while I read", "but who" as "was to"): 5.6 of
/// 348 words lost on Billie Jean's crops, where the lag on /d g/ alone loses none on average.
const RELEASE_LAG: [f64; 3] = [0.0, 0.021, 0.028];
/// At most this share of a short span: a short closure still closes.
const RELEASE_LAG_SHARE: f64 = 0.5;

/// [`RELEASE_LAG`] of stop `def` in a span `dur` long.
fn release_lag(def: &PhonemeDef, dur: f64) -> f64 {
    let only = |keys: &[ArticKey]| def.dominant.iter().all(|k| keys.contains(k));
    let lag = if only(&[ArticKey::TbX, ArticKey::TbY, ArticKey::Root]) {
        RELEASE_LAG[2]
    } else if only(&[ArticKey::LipAp, ArticKey::Labiodental]) {
        RELEASE_LAG[0]
    } else {
        RELEASE_LAG[1]
    };
    js_min(lag, RELEASE_LAG_SHARE * dur)
}

/// How high a vowel's tongue body is between the body's own /a/ (0) and /i/ (1).
fn vowel_height(v: &ArticPatch, body: BodyMix) -> f64 {
    let y = |ipa: &str| vowel_artic(ipa, body).and_then(|p| p.get(ArticKey::TbY));
    match (v.get(ArticKey::TbY), y("a"), y("i")) {
        (Some(x), Some(lo), Some(hi)) if hi > lo => ((x - lo) / (hi - lo)).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

/// The lung pressure a voiced closure at segment `i` is voiced with, relative to the speaking
/// one: the voice multiplies it by the phonation threshold's rise at the pitch
/// ([`threshold_rise`]). The pitch is the closure's own note, else that of the vowel its room is
/// made from, else the plan's baseline `f0`; thin folds above the passaggio, where the voice
/// changes mechanism (it does so a semitone either side, depending on where it comes from).
fn closure_push(segs: &[Seg], i: usize, f0: f64, body: BodyMix) -> f64 {
    let vowel_f0 = segs[..i].iter().rev().chain(&segs[i + 1..]).find(|s| s.vowel.is_some()).and_then(|s| s.f0);
    let f = [segs[i].f0, vowel_f0].into_iter().find(|&x| truthy(x)).flatten().unwrap_or(f0);
    threshold_rise(f, body.body().speaking_f0, if f > REGISTER_PITCH { 1.0 } else { 0.0 })
}

/// The room for a voiced closure over [a, b]: the adjacent vowel's posture, moved by the
/// deltas, more after a high vowel (`height`), and more under a higher lung pressure (`push`,
/// relative to the speaking one, [`closure_push`]).
///
/// The deltas were set at the speaking pressure. A sung note's higher pressure drives more air
/// through the vibrating folds into the sealed tract: the folds' opening is the same (the effort
/// follows the push relative to the threshold, not the pressure), so the flow grows as the square
/// root of the drop across them, and the drop the voice needs grows with the threshold, as the
/// pressure does. The yielding walls and the cavity's own compliance scale with the pressure by
/// themselves; the room the speaker makes does not. With the same room the flow outran it: at
/// 220 Hz the male voice pushes 1.9 times harder and i-g-i stopped voicing 7 ms before the
/// release (78 of 85 sealed ms voiced, the closure's quietest 10 ms 27 dB under the vowel).
/// Grown as the square root of the push, the room keeps pace with the flow, and the pressure
/// behind the closure climbs toward the lung's at the same pace, relative to it, as when spoken.
fn voice_bar(def: &PhonemeDef, vowel: &ArticPatch, height: f64, push: f64, a: f64, b: f64) -> Gesture {
    // a closure the tongue body makes (it owns TbY): /g/, also /ɟ ɢ/
    let dorsal = def.dominant.contains(&ArticKey::TbY);
    let deltas: &[(ArticKey, f64)] = if dorsal { &VOICE_BAR_VELAR } else { &VOICE_BAR };
    let room = sqrt(js_max(1.0, push));
    let mut tg = Targets::default();
    for &(k, d) in deltas {
        let more = match k {
            ArticKey::TbY => HIGH_TBY,
            ArticKey::Larynx => HIGH_LARYNX,
            _ => 0.0,
        };
        if let Some(x) = vowel.get(k) {
            tg.set(k, x + d * room + more * height * room);
        }
    }
    let lead = if dorsal || def.manner == Manner::Tap { HIGH_LEAD * height } else { 0.0 };
    Gesture::new(a - lead, b, 0.02, 0.05 + HIGH_RAMP_OUT * height, VOICE_BAR_STRENGTH + HIGH_STRENGTH * height, tg).label("voice bar")
}

/// Front-to-back order of the oral places of articulation.
fn place_rank(place: &str) -> Option<u8> {
    Some(match place {
        "bilabial" => 0,
        "labiodental" => 1,
        "dental" => 2,
        "alveolar" => 3,
        "postalveolar" => 4,
        "retroflex" => 5,
        "palatal" => 6,
        "velar" => 7,
        "uvular" => 8,
        _ => return None,
    })
}

/// The folds' opening for breathy voice, [ɦ] (cm², adult male; the voice scales it by body size):
/// they keep vibrating, at about half amplitude, beside a steady leak. Sung a-ɦ-a (60 ms, male,
/// pressure 9, tension 0.55) dips 14, 15, 11 and 10 dB at 220, 330, 440 and 550 Hz, about a
/// nasal's dip there (12, 14, 13, 15 dB), with the glottal voicing gate at 0.48 and, at 220 Hz,
/// harmonics 7 dB over the 1.5-5 kHz noise against 16 dB for /m l v/. The earlier 0.1 kept
/// the gate at 0.93 and the noise of a sonorant: a 5 to 8 dB dip, not breathy. 0.16 takes the
/// gate to 0.37 and the dip past any nasal's (17 dB).
const BREATHY_ABDUCTION: f64 = 0.15;

/// Whether segment `i` sits between two voiced sounds (vowels or voiced consonants) with nothing
/// between: no pause (`_`, a rest), no voiceless consonant, no utterance edge. An /h/ there is
/// breathy-voiced [ɦ], as English intervocalic /h/ commonly is ("ahead", "behind", "a heavy"):
/// planned voiceless, its full opening stopped the voice for about 110 ms and the level fell
/// 28 to 34 dB between two sung vowels. A breath written [h̥] ([`VOICELESS_H`]) stays voiceless:
/// a breathed re-attack voiced as [ɦ] dipped 11 dB at 494 Hz instead of 25 to 28, under the
/// 13 dB that marks a new attack (lab/harness/gimmicks.py), and its vowel came 8 ms early.
fn between_voiced(segs: &[Seg], i: usize) -> bool {
    i > 0 && voiced_seg(&segs[i - 1]) && segs.get(i + 1).is_some_and(voiced_seg)
}

/// A vowel or a voiced consonant.
fn voiced_seg(s: &Seg) -> bool {
    s.vowel.is_some() || s.def.is_some_and(|d| d.voicing == Voicing::Voiced)
}

/// A consonant's glottal gesture `g` (the folds held open for /h/, a voiceless consonant or an
/// aspirated stop's release, breathy for ɦ) released by the end of the consonant's
/// span `t0..t1`, where a measured voiced segment starts. Its start stays; its release ramp ends at
/// `t1`, at most half the span long, so a short consonant keeps its folds open through its first
/// half (a 20 ms /h̥/ between vowels released over its whole span was voiced from its middle).
/// Released after the span as planned (35 ms for /h/ and a voiceless fricative, about 65 for an
/// aspirated stop), an aligned vowel's voice reached its level 30 ms (/h/, /s/, /ʃ/, /f/) and
/// 58 ms (/p/, /t/, /k/) past the aligner's boundary, where the singer's was there 20 to 35 ms
/// before it; after a ɦ of 20 to 80 ms between vowels, the vowel was back within 3 dB of its
/// level 25 to 30 ms past its t0 (0 to 5 ms when released by it, the ɦ's dip as deep).
fn closed_by(mut g: Gesture, t0: f64, t1: f64) -> Gesture {
    if g.t1 + g.ramp_out <= t1 {
        return g;
    }
    let ramp = js_max(0.0, js_min(g.ramp_out, js_min(0.5 * (t1 - t0), t1 - g.t0)));
    g.t1 = t1 - ramp;
    g.ramp_out = ramp;
    g
}

/// Whether voiceless stop `i` ends its syllable before a voiced consonant that starts the next
/// one ("that my", "black dog", "it was"). Such a stop is unreleased into that consonant: the
/// folds stay together, so the voice carries on through the closure into the consonant, as a
/// singer's legato and connected speech do. Its unaspirated opening (0.22, up to 5 ms past the
/// release with a 20 ms ramp) used to stop the voice through the closure and the consonant's
/// first 28 ms: sung a-t-m-a (60 ms each, 220 Hz) stayed over 20 dB down for 73 ms, the /m/
/// as low as 38 dB under the vowel. A nasal or a voiced obstruent never shares an English onset
/// with a stop, so it always follows a syllable end. A liquid or glide does ("play", "tree",
/// "quick": released, the approximant devoiced), so only a stop that ends a word counts there.
fn unreleased_into_voiced(segs: &[Seg], i: usize) -> bool {
    let Some(next) = segs.get(i + 1).and_then(|s| s.def.as_ref()) else { return false };
    next.voicing == Voicing::Voiced
        && match next.manner {
            Manner::Nasal | Manner::Stop | Manner::Fricative | Manner::Affricate => true,
            Manner::Approximant | Manner::Lateral | Manner::Tap | Manner::Trill => segs[i].word_end,
            Manner::Glottal | Manner::Vowel => false,
        }
}

/// How much later a pre-placed closure behind another stop's closure is aimed (s): the time its
/// shorter travel saves, so it seals as the front closure opens.
const PLACED_CLOSURE_DELAY: f64 = 0.025;

/// Whether stop `i` closes behind the closure of the stop before it, with its own articulators
/// already set by the consonant before that one (/t/ in /ɹpt/: the tip is up for the /ɹ/ and
/// stays free during the lip closure; a rhotic vowel raises it too). After any other vowel ("apt",
/// "napkin") the timing is unchanged.
fn pre_placed_behind_closure(segs: &[Seg], i: usize) -> bool {
    let (Some(def), Some(prev)) = (segs[i].def.as_ref(), i.checked_sub(1).and_then(|j| segs[j].def.as_ref())) else { return false };
    if def.manner != Manner::Stop || prev.manner != Manner::Stop || !closes_in_front(prev.place, def.place) || i < 2 {
        return false;
    }
    let before = &segs[i - 2];
    let rhotic = before.vowel.as_ref().filter(|v| v.get(ArticKey::TtCurl).unwrap_or(0.0) > 0.05);
    let Some(tg) = before.def.as_ref().map(|d| &d.targets).or(rhotic) else { return false };
    def.dominant.iter().all(|k| tg.get(*k).is_some())
}

/// Whether a closure at `front` lies in front of one at `back`.
fn closes_in_front(front: &str, back: &str) -> bool {
    matches!((place_rank(front), place_rank(back)), (Some(f), Some(b)) if f < b)
}

/// Ramps of a given pitch (a sung note's) on a segment `dur` long: 60 ms, but at most half the
/// segment. A ramp-in starts before the segment, so in a fast run a full 60 ms would pull the
/// previous vowel off its note for most of its length.
fn pitch_ramp(dur: f64) -> f64 {
    js_min(0.06, js_max(0.008, 0.5 * dur))
}

/// Oral gestures for one consonant constriction held acoustically from `a` to `b` (closure to
/// release): a dominant gesture on the consonant's own articulators and a weak one on the rest.
/// Movement latencies are compensated so the acoustic closure and release land on a and b.
pub fn oral_gestures(def: &PhonemeDef, tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str) -> Vec<Gesture> {
    let mut out = Vec::with_capacity(4);
    oral_gestures_into(def, tg, a, b, speed, label, &mut out);
    out
}

/// [`oral_gestures`], appended to `out` (at most four gestures; no allocation when `out` has
/// room for them).
pub fn oral_gestures_into(def: &PhonemeDef, tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str, out: &mut Vec<Gesture>) {
    late_oral_gestures_into(def, tg, a, b, speed, label, 0.0, out);
}

/// [`oral_gestures_into`] with the closing gesture starting `late` s later (its early onset
/// shortened); the other gestures keep the span.
#[allow(clippy::too_many_arguments)]
fn late_oral_gestures_into(def: &PhonemeDef, tg: &ArticPatch, a: f64, b: f64, speed: f64, label: &str, late: f64, out: &mut Vec<Gesture>) {
    let mut dom = ArticPatch::default();
    let mut sec = ArticPatch::default();
    for (k, v) in tg.iter() {
        // A lateral opening is a posture, not a central seal. Let a following central
        // constriction close the sides instead of fighting an equally strong /l/ opening.
        if def.dominant.contains(&k) && k != ArticKey::Lateral {
            dom.set(k, v);
        } else {
            sec.set(k, v);
        }
    }
    // A central coronal constriction also seals the tongue edges. Otherwise a preceding /l/
    // leaves its side passage open even when the tip has reached the stop or sibilant target.
    if def.dominant.contains(&ArticKey::TtY) && tg.get(ArticKey::Lateral).is_none() {
        dom.set(ArticKey::Lateral, -0.1);
    }
    let is = |k: &ArticKey, a: ArticKey, b: ArticKey, c: ArticKey| *k == a || *k == b || *k == c;
    // the dorsum is heavy: its releases are slower than tip and lip releases
    let body_only = def.dominant.iter().all(|k| is(k, ArticKey::TbX, ArticKey::TbY, ArticKey::Root));
    let sp = if body_only { 1.0 + (speed - 1.0) * 0.35 } else { speed };
    // articulators need ~10–15 ms to climb out of the overshoot (contact) target, so the
    // gesture releases early and the acoustic release lands on the planned boundary:
    // measured movement latencies (closure lag / release lag) per articulator class
    let closing = matches!(def.manner, Manner::Stop | Manner::Nasal | Manner::Affricate);
    let lips_only = def.dominant.iter().all(|k| *k == ArticKey::LipAp || *k == ArticKey::Labiodental);
    let lead = if closing { if body_only { 0.034 } else if lips_only { 0.019 } else { 0.02 } } else { 0.0 };
    // a consonant must own its constriction articulators (Task-Dynamics style): at strength 40
    // the overlapping vowel contributes ~2 %, so closures seal instead of being diluted
    let early = if closing { if body_only { 0.024 } else if lips_only { 0.022 } else { 0.031 } } else { 0.008 };
    if !dom.is_empty() {
        // a voiced dorsal stop ends a full release lag before its boundary, never floored at
        // a + 0.01 as a tip or lip one is: with its 34 ms lag the floor held a 20 ms /g/ sealed 20
        // to 26 ms past its span (ə-g-ɝ 43 ms). The 12 ms minimum gesture below still seals it.
        // /k ŋ/ keep the floor: an aligned 20 ms /k/ holds its burst and aspiration, and without
        // the floor's late release Whisper lost "careful" and "cause" (/k/), "think" (/ŋ/)
        let voiced_dorsal_stop = body_only && def.manner == Manner::Stop && def.voicing == Voicing::Voiced;
        let end = if voiced_dorsal_stop { b - lead } else { js_max(a + 0.01, b - lead) };
        out.push(Gesture::new(js_min(a - early + late, end - 0.012), end, 0.03, if body_only { 0.03 } else { 0.018 }, 40.0, artic_targets(&dom)).speed(sp).release_hold(0.045).label(label));
    }
    // alveolars front the tongue body during the closure (the alveolar F2 locus, ~1.8 kHz)
    let alveolar = def.place == "alveolar" && tg.get(ArticKey::TbX).is_none() && matches!(def.manner, Manner::Stop | Manner::Nasal | Manner::Fricative | Manner::Affricate | Manner::Tap);
    if alveolar {
        out.push(Gesture::new(a, b, 0.05, 0.05, 1.2, Targets::default().with(ArticKey::TbX, 3.2).with(ArticKey::TbY, 7.4)).label(label));
    }
    if !sec.is_empty() {
        // a velar's front–back place follows the vowel (fronted /k/ in "key", backed in "caw"):
        // its own tbX only weakly, so the F2 locus moves with the vowel as in natural speech
        let place = if body_only { sec.get(ArticKey::TbX) } else { None };
        if place.is_some() {
            sec.values[ArticKey::TbX.index()] = None;
        }
        if !sec.is_empty() {
            out.push(Gesture::new(a, b, 0.05, 0.05, 2.2, artic_targets(&sec)).label(label));
        }
        if let Some(x) = place {
            out.push(Gesture::new(a, b, 0.05, 0.05, 0.25, one(ArticKey::TbX, x)).label(label));
        }
    }
}

/// One phrase of [`plan_phrases`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhraseInput {
    pub segments: Vec<Segment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intonation: Option<Intonation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause: Option<f64>,
}

/// Plan consecutive phrases (each with its own breath group and intonation) from t0.
/// `o.intonation` is ignored (each phrase brings its own).
pub fn plan_phrases(phrases: &[PhraseInput], o: &PlanOptions) -> Plan {
    let mut all = Plan { gestures: Vec::new(), segments: Vec::new(), end: o.t0 };
    let mut t = o.t0;
    for p in phrases {
        let plan = plan_utterance(&p.segments, &PlanOptions { t0: t, intonation: Some(p.intonation.unwrap_or(Intonation::Statement)), ..o.clone() });
        all.gestures.extend_from_slice(&plan.gestures);
        all.segments.extend(plan.segments);
        t = plan.end + p.pause.unwrap_or(0.25);
        all.end = plan.end;
    }
    all
}
