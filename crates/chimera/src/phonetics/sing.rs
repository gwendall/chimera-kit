//! Singing: syllables on notes, through the same gestural planner as speech.
//!  - A note's vowel lands on the beat. Its onset consonants are sung just before it (they take
//!    their time from the previous note, as singers do), its coda just before the next onset.
//!  - Diphthongs sustain their first vowel and glide to the second at the end of the note.
//!  - A melisma ("-") carries the vowel onto further notes; the coda waits for the last of them.
//!  - Vibrato blooms a quarter of a second into a held vowel.
//!
//! Live playing uses open-ended notes: a key press sings the onset and starts a vowel that lasts
//! until the key is released (tagged gestures, ended with GestureScore.release), and the release
//! sings the glide and the coda.
//!
//! These planners allocate (they run off the audio thread).

use super::inventory::phoneme;
use crate::anatomy::human::BodyMix;
use super::planner::{PlanOptions, diphthong_parts, plan_utterance};
use super::{Intonation, Plan, PlannedSegment, Segment, Syllable};
use crate::control::score::{ControlKey, Gesture, Targets};
use crate::math::{js_max, js_min};
use serde::{Deserialize, Serialize};

/// `440 · 2^((m − 69)/12)`, the same formula and operation order as `sing.ts`.
pub use crate::math::midi_to_hz;

/// sung consonants are a little shorter than spoken ones
fn cdur(ipa: &str, body: BodyMix, k: f64) -> f64 {
    phoneme(ipa, body).map_or(0.07, |d| d.dur) * k
}

fn consonants(segs: &[Segment], body: BodyMix, k: f64) -> Vec<Segment> {
    segs.iter().map(|c| Segment { ipa: c.ipa.clone(), dur: Some(cdur(&c.ipa, body, k)), ..Default::default() }).collect()
}

/// Sung consonants at their note's pitch: an onset consonant moves the pitch to the new note
/// before its vowel (as singers do), a coda holds the old one.
fn consonants_at(segs: &[Segment], body: BodyMix, k: f64, hz: f64) -> Vec<Segment> {
    let mut out = consonants(segs, body, k);
    for c in out.iter_mut() {
        c.f0 = Some(hz);
    }
    out
}

/// a sung vowel keeps at least this long when a short note squeezes its consonants (s)
const MIN_VOWEL: f64 = 0.05;
/// a squeezed consonant keeps at least this long (s); a flap is 16 ms
const MIN_CONSONANT: f64 = 0.012;

/// Fit the consonants between a vowel and the next one into `span`, the time from the vowel's
/// beat to the next vowel's (or to the end of a phrase's last note): when they leave the vowel
/// less than [`MIN_VOWEL`], they shrink in proportion (each down to [`MIN_CONSONANT`]), so the
/// next vowel still lands on its beat and a fast run doesn't drift later note by note.
fn fit(groups: [&mut [Segment]; 2], span: f64) {
    let [a, b] = groups;
    let cons = total(a) + total(b);
    let room = span - MIN_VOWEL;
    if cons <= room || cons <= 0.0 {
        return;
    }
    let scale = js_max(0.0, room) / cons;
    for c in a.iter_mut().chain(b.iter_mut()) {
        c.dur = Some(js_max(MIN_CONSONANT, c.dur.unwrap_or(0.0) * scale));
    }
}

fn total(segs: &[Segment]) -> f64 {
    segs.iter().fold(0.0, |s, c| s + c.dur.unwrap_or(0.0))
}

/// One note's part of an actual sustained vowel. An interval crossing a diphthong's glide
/// names the whole nucleus; one contained in a vowel target names that target.
fn vowel_interval(vowels: &[PlannedSegment], nucleus: &str, a: f64, b: f64) -> PlannedSegment {
    let first = vowels.iter().find(|s| s.t1 > a + 1e-9).unwrap_or(&vowels[vowels.len() - 1]);
    let last = vowels.iter().rev().find(|s| s.t0 < b - 1e-9).unwrap_or(first);
    let mut out = first.clone();
    out.t0 = a;
    out.t1 = b;
    if first.ipa != last.ipa {
        out.ipa = nucleus.to_string();
    }
    out
}

fn vibrato_gesture(t0: f64, t1: f64, depth: f64, tag: Option<f64>) -> Gesture {
    let mut g = Gesture::new(t0 + 0.22, t1, 0.3, 0.06, 4.0, Targets::default().with(ControlKey::VIBRATO, depth)).label("vibrato");
    g.tag = tag;
    g
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SungNote {
    pub midi: f64,
    /// length in beats
    pub beats: f64,
    pub syl: Syllable,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongOptions {
    pub body: BodyMix,
    pub bpm: f64,
    /// plan time of the first note's beat (its onset consonants come before)
    pub t0: f64,
    /// vibrato depth (cents) on held vowels
    pub vibrato: f64,
}

fn melisma(s: &Syllable) -> bool {
    s.melisma == Some(true)
}

/// Plan a whole melody: one utterance per phrase, so each phrase gets its own breath.
pub fn plan_song(notes: &[SungNote], o: &SongOptions) -> Plan {
    let beat = 60.0 / o.bpm;
    let mut gestures: Vec<Gesture> = Vec::new();
    let mut segments: Vec<PlannedSegment> = Vec::new();
    let mut times: Vec<f64> = Vec::with_capacity(notes.len());
    let mut t = o.t0;
    for n in notes {
        times.push(t);
        t += n.beats * beat;
    }
    let mut end = t;
    let mut i = 0;
    while i < notes.len() {
        let mut j = i;
        while j < notes.len() - 1 && !notes[j].syl.phrase_end {
            j += 1;
        }
        let mut segs: Vec<Segment> = Vec::new();
        let mut vowel_spans: Vec<(f64, f64)> = Vec::new();
        // Pitch changes inside a held vowel are not new articulations. Fit the consonants to
        // the entire syllable, so subdividing its pitch contour cannot squeeze its final stop
        // or the following onset into only the last pitch interval.
        let starts: Vec<usize> = (i..=j).filter(|&k| k == i || !melisma(&notes[k].syl)).collect();
        let ends: Vec<usize> = starts.iter().enumerate().map(|(n, _)| starts.get(n + 1).map_or(j, |next| next - 1)).collect();
        let hz_of = |k: usize| midi_to_hz(notes[k].midi);
        let mut onsets: Vec<Vec<Segment>> = starts.iter().map(|&k| consonants_at(&notes[k].syl.onset, o.body, 0.8, hz_of(k))).collect();
        let mut codas: Vec<Vec<Segment>> = starts.iter().zip(&ends)
            .map(|(&k, &last)| consonants_at(&notes[k].syl.coda, o.body, 0.8, hz_of(last)))
            .collect();
        // the phrase's last vowel leaves a short breath before the next phrase. The call's last
        // phrase is followed by a rest (callers split phrases at rests), so the breath comes from
        // the rest: hold that note to its end, less the breath's release.
        let reserve = if j == notes.len() - 1 { 0.05 } else { 0.12 };
        let last_start = *starts.last().unwrap();
        let last_duration = if last_start == j { notes[j].beats * beat } else { times[j] + notes[j].beats * beat - times[last_start] };
        let last_end = times[j] + notes[j].beats * beat - js_min(reserve, 0.3 * last_duration);
        for (n, &k) in starts.iter().enumerate() {
            let (span, next) = if n + 1 < starts.len() { (times[starts[n + 1]] - times[k], &mut onsets[n + 1][..]) } else { (last_end - times[k], &mut [][..]) };
            fit([&mut codas[n][..], next], span);
        }
        let first_onset = total(&onsets[0]);
        let mut pitch_spans = Vec::new();
        for (syllable, &k) in starts.iter().enumerate() {
            let n = &notes[k];
            let hz = hz_of(k);
            let coda = std::mem::take(&mut codas[syllable]);
            let onset = std::mem::take(&mut onsets[syllable]);
            // vowel from this note's beat to the next note's onset (less this note's coda)
            let note_end = if syllable + 1 < starts.len() { times[starts[syllable + 1]] - total(&onsets[syllable + 1]) } else { last_end };
            // only consonants squeezed to their floor can leave less than MIN_VOWEL
            let vdur = js_max(0.02, note_end - times[k] - total(&coda));
            segs.extend(onset);
            let vowel_first = segs.len();
            let parts = diphthong_parts(&n.syl.nucleus.ipa);
            match parts {
                Some((a, b)) => {
                    segs.push(Segment { ipa: a.to_string(), dur: Some(vdur * 0.8), f0: Some(hz), stress: Some(1), word_end: None });
                    segs.push(Segment { ipa: b.to_string(), dur: Some(vdur * 0.2), f0: Some(hz), stress: Some(1), word_end: None });
                }
                _ => {
                    let ipa = parts.map_or(n.syl.nucleus.ipa.clone(), |p| p.0.to_string());
                    segs.push(Segment { ipa, dur: Some(vdur), f0: Some(hz), stress: Some(1), word_end: None });
                }
            }
            let vowel_last = segs.len() - 1;
            segs.extend(coda);
            vowel_spans.push((times[k], times[k] + vdur));
            if ends[syllable] > k {
                pitch_spans.push((k, ends[syllable], vowel_first, vowel_last, segs.len() - 1));
            }
        }
        if !segs.is_empty() {
            // the planner lays segments out from t0 + 0.06: start so the first vowel lands on its beat
            let mut plan = plan_utterance(&segs, &PlanOptions { body: o.body, t0: times[i] - first_onset - 0.06, f0: Some(hz_of(i)), intonation: Some(Intonation::Flat), sung: Some(true), ..Default::default() });
            for &(first, last, vowel_first, _, syllable_last) in &pitch_spans {
                // Diphthongs were expanded above. These indices also track the slight timing
                // drift when irreducible consonant floors overfill an exceptionally short run.
                let a = plan.segments[vowel_first].t0;
                let b = plan.segments[syllable_last].t1;
                // Pitch follows the melody independently through the vowel and its coda. The
                // next syllable's onset still takes its new pitch before its own vowel starts.
                plan.gestures.retain(|g| !(g.targets.has(ControlKey::F0) && g.t0 >= a - 1e-9 && g.t0 < b - 1e-9 && g.t1 <= b + 1e-9));
                for k in first..=last {
                    let start = times[k];
                    let end = js_min(b, if k < last { times[k + 1] } else { b });
                    if end > start {
                        let ramp = js_min(0.06, js_max(0.008, 0.5 * (end - start)));
                        plan.gestures.push(Gesture::new(start, end, ramp, ramp, 6.0, Targets::default().with(ControlKey::F0, hz_of(k))).label("pitch"));
                    }
                }
            }
            // Note consumers still need each pitch interval's vowel timing. Partition only the
            // timeline metadata at pitch boundaries; the oral gesture above stays continuous.
            // A pitch point inside a coda creates no fictitious vowel segment.
            if !pitch_spans.is_empty() {
                let mut timed = Vec::new();
                let mut cursor = 0;
                for &(first, last, vowel_first, vowel_last, _) in &pitch_spans {
                    timed.extend_from_slice(&plan.segments[cursor..vowel_first]);
                    let vowels = &plan.segments[vowel_first..=vowel_last];
                    let start = vowels[0].t0;
                    let end = vowels[vowels.len() - 1].t1;
                    for k in first..=last {
                        let a = js_max(start, times[k]);
                        let b = js_min(end, if k < last { times[k + 1] } else { end });
                        if b <= a {
                            continue;
                        }
                        let nucleus = &notes[first].syl.nucleus.ipa;
                        if k == last && diphthong_parts(nucleus).is_some() {
                            let glide = vowels[vowels.len() - 1].t0;
                            // Consumers retain the last note's two vowel phases. If the glide
                            // began on an earlier note, both phases continue the same real target.
                            let cut = if glide > a && glide < b { glide } else { 0.5 * (a + b) };
                            timed.push(vowel_interval(vowels, nucleus, a, cut));
                            timed.push(vowel_interval(vowels, nucleus, cut, b));
                        } else {
                            timed.push(vowel_interval(vowels, nucleus, a, b));
                        }
                    }
                    cursor = vowel_last + 1;
                }
                timed.extend_from_slice(&plan.segments[cursor..]);
                plan.segments = timed;
            }
            gestures.extend_from_slice(&plan.gestures);
            segments.extend(plan.segments);
            for (a, b) in vowel_spans {
                if b - a > 0.3 {
                    gestures.push(vibrato_gesture(a, b, o.vibrato, None));
                }
            }
            end = js_max(end, plan.end);
        }
        i = j + 1;
    }
    Plan { gestures, segments, end }
}

/// Live: gestures relative to "now" (the planner's 60 ms lead is mostly taken back).
const LIVE_T0: f64 = -0.045;
/// a held vowel lasts at most this long (s)
const HOLD: f64 = 30.0;

/// The previous note of a legato pair.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegatoFrom {
    pub syl: Syllable,
    pub midi: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteOnOptions {
    pub body: BodyMix,
    pub vibrato: f64,
    pub tag: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legato_from: Option<LegatoFrom>,
}

/// Key pressed: sing the previous syllable's glide and coda if it is still sounding (legato),
/// then this syllable's onset, then its vowel held open-ended. Every gesture gets `tag`; the
/// pitch and vibrato get `tag + 1`, so a melisma can change pitch without ending the vowel.
pub fn plan_note_on(syl: &Syllable, midi: f64, o: &NoteOnOptions) -> Vec<Gesture> {
    let hz = midi_to_hz(midi);
    let mut segs: Vec<Segment> = Vec::new();
    if let Some(l) = &o.legato_from {
        segs.extend(tail(&l.syl, o.body, midi_to_hz(l.midi)));
    }
    segs.extend(consonants(&syl.onset, o.body, 0.7));
    let parts = diphthong_parts(&syl.nucleus.ipa);
    segs.push(Segment { ipa: parts.map_or(syl.nucleus.ipa.clone(), |p| p.0.to_string()), dur: Some(HOLD), f0: Some(hz), stress: Some(1), word_end: None });
    let plan = plan_utterance(&segs, &PlanOptions { body: o.body, t0: LIVE_T0, f0: Some(hz), intonation: Some(Intonation::Flat), open_end: Some(true), ..Default::default() });
    let vowel = &plan.segments[plan.segments.len() - 1];
    let mut out: Vec<Gesture> = plan.gestures.iter().map(|g| g.tag(if g.targets.has(ControlKey::F0) { o.tag + 1.0 } else { o.tag })).collect();
    out.push(vibrato_gesture(vowel.t0, vowel.t1, o.vibrato, Some(o.tag + 1.0)));
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MelismaOptions {
    pub vibrato: f64,
    pub tag: f64,
}

/// Melisma, live: the held vowel moves to a new pitch (release tag + 1 first).
pub fn plan_melisma(midi: f64, o: &MelismaOptions) -> Vec<Gesture> {
    let MelismaOptions { vibrato, tag } = *o;
    vec![
        Gesture::new(0.0, HOLD, 0.05, 0.06, 6.0, Targets::default().with(ControlKey::F0, midi_to_hz(midi))).label("pitch").tag(tag + 1.0),
        vibrato_gesture(0.0, HOLD, vibrato, Some(tag + 1.0)),
    ]
}

/// Key released: the diphthong's glide and the coda (release the note's tags first).
pub fn plan_note_off(syl: &Syllable, midi: f64, body: BodyMix) -> Vec<Gesture> {
    let hz = midi_to_hz(midi);
    let segs = tail(syl, body, hz);
    if segs.is_empty() {
        return Vec::new();
    }
    plan_utterance(&segs, &PlanOptions { body, t0: LIVE_T0, f0: Some(hz), intonation: Some(Intonation::Flat), ..Default::default() }).gestures
}

/// What follows a held vowel: the diphthong's glide (at the note's pitch) and the coda.
fn tail(syl: &Syllable, body: BodyMix, hz: f64) -> Vec<Segment> {
    let parts = diphthong_parts(&syl.nucleus.ipa);
    let mut out: Vec<Segment> = Vec::new();
    if let Some((_, b)) = parts {
        out.push(Segment { ipa: b.to_string(), dur: Some(0.07), stress: Some(1), f0: Some(hz), word_end: None });
    }
    out.extend(consonants(&syl.coda, body, 0.7));
    out
}
