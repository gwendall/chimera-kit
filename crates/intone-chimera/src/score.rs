//! Layer 2 of the design (`docs/design.md`): a score says exactly what to sound, when, and how.
//! `Score` matches `src/layers.ts`'s `Score` type field for field; this module is the Rust side
//! of that one contract. [`from_plan`] builds a score from the planner's own output (the
//! direction this commit adds); rendering a score back (the reverse) follows in its own commit.

use chimera::phonetics::Plan;
use chimera::phonetics::english::Phrase;
use chimera::phonetics::planner::expand;
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
    /// changes value is refused when a score is rendered.
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
        let f0 = board.blend(chimera::control::score::ControlKey::F0, t);
        if f0.weight > 0.0 {
            last_f0 = f0.value;
        }
        pitch.push([t, last_f0]);
        let b = board.blend(chimera::control::score::ControlKey::BREATH, t);
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
