//! Layer 2 of the design (`docs/design.md`): a score says exactly what to sound, when, and how.
//! `Score` matches `src/layers.ts`'s `Score` type field for field; this module is the Rust side
//! of that one contract. [`from_plan`] builds a score from the planner's own output; [`plan_from_score`]
//! is the reverse, porting `chimera-lab/crates/chimera-cli/src/performance.rs`'s `Performance::plan`
//! (measured phone boundaries, kept exact) to a [`Score`] instead of a `Performance`.

use chimera::anatomy::human::BodyMix;
use chimera::control::score::{ControlKey, Gesture, Targets, activation};
use chimera::phonetics::english::Phrase;
use chimera::phonetics::inventory::phoneme;
use chimera::phonetics::planner::{PlanOptions, expand, is_vowel, plan_utterance};
use chimera::phonetics::{Intonation, Plan, Segment};
use serde::{Deserialize, Serialize};

/// Points of a curve over time: `[seconds, value]`, linear between points, held past the ends.
pub type Curve = Vec<[f64; 2]>;

/// One timed sound of a score.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sound {
    /// An IPA phone, `"_"` for silence, or a sound the body defines.
    pub sound: String,
    pub t0: f64,
    pub t1: f64,
    /// Lexical stress of a vowel: 0 unstressed, 1 primary, 2 secondary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stress: Option<u8>,
}

/// Where a word lies in a score, so that it can be selected by its text.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordSpan {
    pub text: String,
    pub t0: f64,
    pub t1: f64,
}

/// Layer 2: exactly what to sound and when, and how. Identical in shape to `src/layers.ts`'s
/// `Score`: the wire contract both sides of the ABI serialize.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Score {
    /// Total length in seconds, silence after the last sound included.
    pub duration: f64,
    pub sounds: Vec<Sound>,
    /// Fundamental frequency in Hz.
    pub pitch: Curve,
    /// Level in dB relative to the voice's own. Applied as a gain on the rendered samples:
    /// CHIMERA has no per-time loudness control, but any curve can be honored this way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loudness: Option<Curve>,
    /// 0 clean, 1 all air: sampled from, and fed back into, CHIMERA's `Breath` source control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breath: Option<Curve>,
    /// 0 lax, 1 pressed. CHIMERA only has a static tension, set once per utterance: a curve that
    /// changes value is refused (see `plan_from_score`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tension: Option<Curve>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<WordSpan>>,
}

/// Linear interpolation of a curve at `t`, held past its ends. An empty curve is 0 everywhere.
pub fn curve_value(curve: &[[f64; 2]], t: f64) -> f64 {
    let Some(&[t0, v0]) = curve.first() else {
        return 0.0;
    };
    if t <= t0 {
        return v0;
    }
    let Some(&[tn, vn]) = curve.last() else {
        return v0;
    };
    if t >= tn {
        return vn;
    }
    // first index whose time is > t; bounded in [1, curve.len() - 1] because t0 < t < tn
    let i = curve.partition_point(|p| p[0] <= t);
    let [a, x] = curve[i - 1];
    let [b, y] = curve[i];
    if b > a {
        x + (y - x) * (t - a) / (b - a)
    } else {
        x
    }
}

/// The single value of a curve that does not change (within floating tolerance), or `None` for
/// an empty curve. Used for fields CHIMERA can only set once per utterance (tension).
fn constant_value(curve: &[[f64; 2]], name: &str) -> Result<Option<f64>, String> {
    let Some(&[_, first]) = curve.first() else {
        return Ok(None);
    };
    if curve.iter().any(|&[_, v]| (v - first).abs() > 1e-9) {
        return Err(format!(
            "{name} changes over time, which CHIMERA has no control to follow: give one constant value"
        ));
    }
    Ok(Some(first))
}

fn validate_curve(
    curve: &[[f64; 2]],
    duration: f64,
    name: &str,
    low: f64,
    high: f64,
) -> Result<(), String> {
    let mut previous = f64::NEG_INFINITY;
    for &[t, v] in curve {
        if !t.is_finite()
            || t < 0.0
            || t > duration + 1e-9
            || t <= previous
            || !v.is_finite()
            || v < low
            || v > high
        {
            return Err(format!(
                "{name} has an invalid point at t={t}, v={v}: times must increase, 0..{duration}; values {low}..{high}"
            ));
        }
        previous = t;
    }
    Ok(())
}

/// Checks every constraint `docs/design.md`'s layer 2 states: times in order and inside
/// `duration`, sounds known to this body, curve values in range.
fn validate(score: &Score, body: BodyMix) -> Result<(), String> {
    if !score.duration.is_finite() || score.duration <= 0.0 || score.duration > 600.0 {
        return Err(format!(
            "score.duration must be finite, 0 < duration <= 600 seconds, got {}",
            score.duration
        ));
    }
    if score.sounds.is_empty() {
        return Err("score.sounds must not be empty".into());
    }
    if score.pitch.is_empty() {
        return Err("score.pitch must have at least one point".into());
    }
    validate_curve(&score.pitch, score.duration, "score.pitch", 20.0, 2000.0)?;
    if let Some(c) = &score.loudness {
        validate_curve(c, score.duration, "score.loudness", -60.0, 24.0)?;
    }
    if let Some(c) = &score.breath {
        validate_curve(c, score.duration, "score.breath", 0.0, 1.0)?;
    }
    if let Some(c) = &score.tension {
        validate_curve(c, score.duration, "score.tension", 0.0, 1.0)?;
    }
    let mut end = 0.0;
    for (i, s) in score.sounds.iter().enumerate() {
        if let Some(stress) = s.stress
            && stress > 2
        {
            return Err(format!(
                "score.sounds[{i}].stress must be 0, 1 or 2, got {stress}"
            ));
        }
        if !s.t0.is_finite()
            || !s.t1.is_finite()
            || s.t0 < end - 1e-9
            || s.t1 <= s.t0
            || s.t1 > score.duration + 1e-9
        {
            return Err(format!(
                "score.sounds[{i}] ({:?}) has an invalid or overlapping span {}..{}",
                s.sound, s.t0, s.t1
            ));
        }
        if s.sound != "_" && !is_vowel(&s.sound, body) && phoneme(&s.sound, body).is_none() {
            return Err(format!(
                "score.sounds[{i}] names a sound {:?} unknown to this body",
                s.sound
            ));
        }
        end = s.t1;
    }
    if let Some(words) = &score.words {
        let mut wend = 0.0;
        for (i, w) in words.iter().enumerate() {
            if !w.t0.is_finite()
                || !w.t1.is_finite()
                || w.t0 < wend - 1e-9
                || w.t1 <= w.t0
                || w.t1 > score.duration + 1e-9
            {
                return Err(format!(
                    "score.words[{i}] ({:?}) has an invalid or overlapping span {}..{}",
                    w.text, w.t0, w.t1
                ));
            }
            wend = w.t1;
        }
    }
    Ok(())
}

/// Fixed resampling step for curves turned into gestures: fine enough that a piecewise-constant
/// gesture per sample reads as a smooth ramp (or a sharp step, if the curve itself jumps faster
/// than this), coarse enough to leave room in the gesture score for the sounds themselves.
const CURVE_STEP: f64 = 0.01;

/// A curve resampled onto a fixed time grid, so that [`curve_gestures`] (one gesture per point,
/// holding its target constant across the point) approximates the curve's own linear shape
/// instead of only hitting its original, possibly sparse, points.
fn resample(curve: &[[f64; 2]], duration: f64, step: f64) -> Curve {
    let steps = (duration / step).ceil().max(1.0) as usize;
    (0..=steps)
        .map(|i| {
            let t = ((i as f64) * step).min(duration);
            [t, curve_value(curve, t)]
        })
        .collect()
}

/// A curve as gestures on one control key, ramped between points (`performance.rs`'s `curve`).
fn curve_gestures(points: &[[f64; 2]], end: f64, key: ControlKey, label: &str) -> Vec<Gesture> {
    points
        .iter()
        .enumerate()
        .map(|(i, &[time, value])| {
            let next = points.get(i + 1).map_or(end, |p| p[0]);
            let ramp = (0.5 * (next - time)).clamp(0.001, 0.008);
            Gesture::new(
                time,
                next,
                ramp,
                ramp,
                6.0,
                Targets::default().with(key, value),
            )
            .label(label)
        })
        .collect()
}

/// Ported from `chimera-lab/crates/chimera-cli/src/performance.rs::plan`: keeps the score's sound
/// boundaries exact; pitch and breath changes never create, move or shorten a sound. Returns the
/// gesture plan and, if `score.tension` sets one, the constant tension to apply once.
pub fn plan_from_score(score: &Score, body: BodyMix) -> Result<(Plan, Option<f64>), String> {
    validate(score, body)?;
    let tension = constant_value(score.tension.as_deref().unwrap_or(&[]), "score.tension")?;
    let f0 = score.pitch.first().map_or(110.0, |p| p[1]);
    let mut result = Plan::default();
    let mut index = 0;
    while index < score.sounds.len() {
        let first = index;
        let mut segments = Vec::new();
        let mut gaps = Vec::new();
        let mut previous = score.sounds[index].t0;
        while index < score.sounds.len() {
            let s = &score.sounds[index];
            let gap = s.t0 - previous;
            if index > first && gap > 0.1 {
                break;
            }
            if gap > 1e-9 {
                // A short unlabelled interval stays silent while the tract coarticulates.
                segments.push(Segment {
                    ipa: "_".into(),
                    dur: Some(gap),
                    ..Default::default()
                });
                gaps.push((previous, s.t0));
            }
            if s.sound == "_" {
                segments.push(Segment {
                    ipa: "_".into(),
                    dur: Some(s.t1 - s.t0),
                    ..Default::default()
                });
                gaps.push((s.t0, s.t1));
            } else {
                segments.push(Segment {
                    ipa: s.sound.clone(),
                    dur: Some(s.t1 - s.t0),
                    stress: s.stress,
                    f0: Some(f0),
                    word_end: None,
                });
            }
            previous = s.t1;
            index += 1;
        }
        let mut p = plan_utterance(
            &segments,
            &PlanOptions {
                body,
                t0: score.sounds[first].t0 - 0.06,
                f0: Some(f0),
                intonation: Some(Intonation::Flat),
                sung: Some(true),
                ..Default::default()
            },
        );
        p.segments.retain(|s| s.ipa != "_");
        for (a, b) in gaps {
            p.gestures.push(
                Gesture::new(
                    a,
                    b,
                    0.004,
                    0.004,
                    100.0,
                    Targets::default().with(ControlKey::BREATH, 0.0),
                )
                .label("silence"),
            );
        }
        result.gestures.extend(p.gestures);
        result.segments.extend(p.segments);
        result.end = result.end.max(p.end);
    }
    // The score's own pitch curve replaces the planner's intonation guesses entirely: it is a
    // required field, so every gesture's F0/vibrato target is stripped and rebuilt from it.
    for g in &mut result.gestures {
        g.targets.remove(ControlKey::F0);
        g.targets.remove(ControlKey::VIBRATO);
    }
    result.gestures.retain(|g| !g.targets.is_empty());
    result.gestures.extend(curve_gestures(
        &resample(&score.pitch, score.duration, CURVE_STEP),
        score.duration,
        ControlKey::F0,
        "pitch",
    ));
    if let Some(breath) = score.breath.as_ref().filter(|c| !c.is_empty()) {
        // A measured breath contour scales the phrase's own breathing. It must not sustain
        // phonation through unlabelled gaps or replace the phrase's attack/release envelope
        // (ported verbatim from `performance.rs`, whose comment this restates).
        let breathing: Vec<_> = result
            .gestures
            .iter()
            .filter(|g| g.label_str() == "breath")
            .copied()
            .collect();
        let silences: Vec<_> = result
            .gestures
            .iter()
            .filter(|g| g.label_str() == "silence")
            .map(|g| (g.t0, g.t1))
            .collect();
        let mut times: Vec<_> = (0..=(score.duration * 100.0).ceil() as usize)
            .map(|i| (i as f64 / 100.0).min(score.duration))
            .collect();
        for &(a, b) in &silences {
            times.extend([a, (a + b) * 0.5, b]);
        }
        times.sort_by(f64::total_cmp);
        times.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        let mut point = 0;
        let measured: Vec<_> = times
            .into_iter()
            .map(|t| {
                while point + 1 < breath.len() && breath[point + 1][0] <= t {
                    point += 1;
                }
                let mut value = if t < breath[0][0] {
                    0.0
                } else {
                    breath[point][1]
                };
                if point + 1 < breath.len() && t >= breath[0][0] {
                    let [a, x] = breath[point];
                    let [b, y] = breath[point + 1];
                    value = x + (y - x) * ((t - a) / (b - a)).clamp(0.0, 1.0);
                }
                let envelope = if silences.iter().any(|&(a, b)| t >= a && t <= b) {
                    0.0
                } else {
                    breathing
                        .iter()
                        .map(|g| activation(g, t))
                        .fold(0.0, f64::max)
                };
                [t, value * envelope]
            })
            .collect();
        for g in &mut result.gestures {
            g.targets.remove(ControlKey::BREATH);
        }
        result.gestures.retain(|g| !g.targets.is_empty());
        result.gestures.extend(curve_gestures(
            &measured,
            score.duration,
            ControlKey::BREATH,
            "breath",
        ));
    }
    Ok((result, tension))
}

/// The number of planner segments one G2P segment expands into (diphthongs split in two; `expand`
/// is `pub` in `chimera::phonetics::planner` for exactly this: matching the planner's own count
/// without duplicating its expansion table).
fn expanded_len(ipa: &str) -> usize {
    expand(ipa).map_or(1, <[&str]>::len)
}

/// Word spans recovered from the G2P's own word-end markers (`Segment::word_end`), mapped through
/// the planner's diphthong expansion to the planned segments' times. `None` if a phrase's word
/// count and its word-end markers disagree (should not happen for text the G2P produced itself).
fn recover_words(plan: &Plan, phrases: &[Phrase]) -> Option<Vec<WordSpan>> {
    let mut words = Vec::new();
    let mut cursor = 0usize;
    for phrase in phrases {
        let mut word_i = 0usize;
        let mut seg_in_phrase = 0usize;
        let mut word_start = cursor;
        for seg in &phrase.segments {
            seg_in_phrase += expanded_len(&seg.ipa);
            if seg.word_end == Some(true) {
                let end_idx = cursor + seg_in_phrase - 1;
                let text = phrase.words.get(word_i)?;
                let first = plan.segments.get(word_start)?;
                let last = plan.segments.get(end_idx)?;
                words.push(WordSpan {
                    text: text.clone(),
                    t0: first.t0,
                    t1: last.t1,
                });
                word_i += 1;
                word_start = cursor + seg_in_phrase;
            }
        }
        if word_i != phrase.words.len() {
            return None;
        }
        cursor += seg_in_phrase;
    }
    Some(words)
}

/// A score from the planner's own output: sounds from the timed segments (silence filled in
/// explicitly between them), pitch and breath sampled from the plan's `F0` and `Breath` source
/// controls every `step` seconds, and words when the G2P's markers recover cleanly.
pub fn from_plan(plan: &Plan, phrases: &[Phrase], base_f0: f64) -> Score {
    const STEP: f64 = 0.01;

    let mut sounds = Vec::with_capacity(plan.segments.len() + phrases.len() + 1);
    let mut at = 0.0;
    for seg in &plan.segments {
        if seg.t0 > at + 1e-9 {
            sounds.push(Sound {
                sound: "_".into(),
                t0: at,
                t1: seg.t0,
                stress: None,
            });
        }
        sounds.push(Sound {
            sound: seg.ipa.clone(),
            t0: seg.t0,
            t1: seg.t1,
            stress: seg.stress,
        });
        at = seg.t1;
    }
    let duration = (plan.end + crate::TAIL_SECONDS).max(at);
    if duration > at + 1e-9 {
        sounds.push(Sound {
            sound: "_".into(),
            t0: at,
            t1: duration,
            stress: None,
        });
    }

    let mut board = chimera::control::score::GestureScore::new();
    board.add_all(&plan.gestures);
    let steps = (duration / STEP).ceil().max(1.0) as usize;
    let mut pitch = Vec::with_capacity(steps + 1);
    let mut breath = Vec::with_capacity(steps + 1);
    let mut last_f0 = base_f0;
    for i in 0..=steps {
        let t = ((i as f64) * STEP).min(duration);
        let f0 = board.blend(ControlKey::F0, t);
        if f0.weight > 0.0 {
            last_f0 = f0.value;
        }
        pitch.push([t, last_f0]);
        let b = board.blend(ControlKey::BREATH, t);
        breath.push([
            t,
            if b.weight > 0.0 {
                b.value.max(0.0)
            } else {
                0.0
            },
        ]);
    }

    let words = recover_words(plan, phrases);
    Score {
        duration,
        sounds,
        pitch,
        loudness: None,
        breath: Some(breath),
        tension: None,
        words,
    }
}
