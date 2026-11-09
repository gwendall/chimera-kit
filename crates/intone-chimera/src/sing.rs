//! Layer 2 for singing (`docs/design.md`'s "a melody is a phrasing too"): lyrics and notes become
//! a score through the same path `score::plan_from_score`/`Speaker::utterance_from_score` render,
//! using CHIMERA's own `lyrics_to_syllables` and `plan_song`
//! (`crates/chimera/src/phonetics/{syllables,sing}.rs`).
//!
//! **Notes map to syllables one to one**, in the order `lyrics_to_syllables` returns them: typed
//! hyphens split a word's syllables explicitly ("twin-kle"), and a lone "-" or "~" (surrounded by
//! spaces) is a melisma note that holds the previous syllable's vowel without starting a new one.
//! So four notes for "Lights go down -" sing "Lights" and "go" each on their own note, "down" on
//! the third, and hold it through the fourth. `notes.len()` must equal the lyrics' syllable count;
//! the error names both counts when it doesn't, since the usual mistake is one more or fewer note
//! than the lyrics need.

use crate::Body;
use crate::score::{Curve, Score, WordSpan};
use chimera::control::score::{ControlKey, GestureScore};
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::planner::diphthong_parts;
use chimera::phonetics::sing::{SongOptions, SungNote, midi_to_hz, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;
use chimera::phonetics::{Plan, Syllable};
use serde::Deserialize;

/// One note of a melody: a pitch and a length in beats. Its lyric comes from its matching
/// syllable of `SingRequest::lyrics` (see the module docs).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoteInput {
    /// MIDI note number (69 = A4 = 440 Hz); need not be an integer.
    pub midi: f64,
    /// Length in beats, at `SingRequest::bpm`.
    pub beats: f64,
}

/// A melody with lyrics: layer 2's singing input, planned into a [`Score`] by [`sing`].
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingRequest {
    /// Words, syllable hyphens, melisma marks ("-" or "~", each surrounded by spaces) and phrase
    /// punctuation; see `lyrics_to_syllables`. Its syllable count must equal `notes.len()`.
    pub lyrics: String,
    pub notes: Vec<NoteInput>,
    pub bpm: f64,
    #[serde(default)]
    pub body: Body,
    /// Vibrato depth in cents on held vowels (0 for none); blooms a quarter second into the hold.
    #[serde(default)]
    pub vibrato: f64,
    /// Plan time of the first note's beat; its onset consonants sound before it.
    #[serde(default)]
    pub t0: f64,
}

impl SingRequest {
    fn validate(&self) -> Result<(), String> {
        if !(self.bpm.is_finite() && self.bpm > 0.0 && self.bpm <= 400.0) {
            return Err(format!("bpm must be in (0, 400], got {}", self.bpm));
        }
        if !(self.vibrato.is_finite() && (0.0..=400.0).contains(&self.vibrato)) {
            return Err(format!(
                "vibrato must be between 0 and 400 cents, got {}",
                self.vibrato
            ));
        }
        if !(self.t0.is_finite() && self.t0 >= 0.0) {
            return Err(format!("t0 must be finite and >= 0, got {}", self.t0));
        }
        if self.notes.is_empty() {
            return Err("notes must not be empty".into());
        }
        for (i, n) in self.notes.iter().enumerate() {
            if !(n.midi.is_finite() && (0.0..=127.0).contains(&n.midi)) {
                return Err(format!(
                    "notes[{i}].midi must be between 0 and 127, got {}",
                    n.midi
                ));
            }
            if !(n.beats.is_finite() && n.beats > 0.0) {
                return Err(format!("notes[{i}].beats must be > 0, got {}", n.beats));
            }
        }
        Ok(())
    }
}

fn is_melisma(s: &Syllable) -> bool {
    s.melisma == Some(true)
}

/// The syllable whose coda ends a melisma chain starting at note `k`: mirrors the private
/// `last_of_chain` in `chimera::phonetics::sing` (a melisma syllable carries no coda of its own;
/// the chain's own coda sounds only after its last note).
fn last_of_chain(notes: &[SungNote], k: usize) -> &Syllable {
    let mut b = k;
    while b > 0 && is_melisma(&notes[b].syl) {
        b -= 1;
    }
    &notes[b].syl
}

/// How many planned segments note `k` contributes: its onset (none for a melisma), its vowel (two
/// for a diphthong that isn't held into a melisma, one otherwise), and its coda (none if the next
/// note is a melisma continuing the same vowel; the chain's own coda otherwise). This mirrors the
/// counting `plan_song` does while laying its `segs` out; `plan_song`'s own fitting only scales
/// durations, never how many segments a note contributes, so this stays exact without duplicating
/// fitting. Assumes a melisma mark never crosses a phrase break (ordinary lyrics never produce one
/// that does: a phrase only ends on punctuation, and nothing sings through a breath).
fn segment_count(notes: &[SungNote], k: usize) -> usize {
    let n = &notes[k];
    let onset = if is_melisma(&n.syl) {
        0
    } else {
        n.syl.onset.len()
    };
    let next_melisma = k + 1 < notes.len() && is_melisma(&notes[k + 1].syl);
    let vowel = if diphthong_parts(&n.syl.nucleus.ipa).is_some() && !next_melisma {
        2
    } else {
        1
    };
    let coda = if next_melisma {
        0
    } else {
        last_of_chain(notes, k).coda.len()
    };
    onset + vowel + coda
}

/// A word's lyric text: its syllables' spelling, concatenated ("twin" + "kle" -> "twinkle"); a
/// melisma or placeholder fragment ("~") contributes nothing.
fn word_text(notes: &[SungNote], first: usize, last: usize) -> String {
    notes[first..=last]
        .iter()
        .map(|n| n.syl.text.as_str())
        .filter(|t| *t != "~")
        .collect()
}

/// One closed word: `first..=last` are note indices, `starts` is each note's first segment index
/// (from [`word_spans`]).
fn close_word(
    notes: &[SungNote],
    plan: &Plan,
    starts: &[usize],
    first: usize,
    last: usize,
) -> Option<WordSpan> {
    let seg_start = starts[first];
    let seg_end = starts[last] + segment_count(notes, last); // exclusive
    let t0 = plan.segments.get(seg_start)?.t0;
    let t1 = plan.segments.get(seg_end - 1)?.t1;
    Some(WordSpan {
        text: word_text(notes, first, last),
        t0,
        t1,
    })
}

/// Word spans named from the lyrics, timed from the planned segments: each note is one syllable
/// (see the module docs), so a word is a run of notes up to and including the one that ends it
/// (`Syllable::word_end`), plus any melisma notes that continue holding it afterwards. `None` if
/// the segment count this function computes doesn't match the plan's own segment count (should
/// not happen for a plan [`sing`] built from the same notes).
fn word_spans(notes: &[SungNote], plan: &Plan) -> Option<Vec<WordSpan>> {
    let mut starts = Vec::with_capacity(notes.len());
    let mut at = 0usize;
    for k in 0..notes.len() {
        starts.push(at);
        at += segment_count(notes, k);
    }
    if at != plan.segments.len() {
        return None;
    }
    let mut words = Vec::new();
    let mut word_start = 0usize;
    for k in 1..notes.len() {
        let starts_new = !is_melisma(&notes[k].syl) && notes[k - 1].syl.word_end;
        if starts_new {
            words.push(close_word(notes, plan, &starts, word_start, k - 1)?);
            word_start = k;
        }
    }
    words.push(close_word(
        notes,
        plan,
        &starts,
        word_start,
        notes.len() - 1,
    )?);
    Some(words)
}

/// Matches `score::from_plan`'s own sampling step, so a vibrato curve and the pitch/breath curves
/// it samples resolve the same gestures at the same resolution.
const CURVE_STEP: f64 = 0.01;

/// A source control sampled from a plan's gestures the same way `score::from_plan` samples pitch
/// and breath: the strength-weighted mean of active gestures' targets at each step, 0 where
/// nothing is active.
fn sample_source(plan: &Plan, key: ControlKey, duration: f64) -> Curve {
    let mut board = GestureScore::new();
    board.add_all(&plan.gestures);
    let steps = (duration / CURVE_STEP).ceil().max(1.0) as usize;
    (0..=steps)
        .map(|i| {
            let t = ((i as f64) * CURVE_STEP).min(duration);
            let b = board.blend(key, t);
            [
                t,
                if b.weight > 0.0 {
                    b.value.max(0.0)
                } else {
                    0.0
                },
            ]
        })
        .collect()
}

/// Plans a melody with lyrics into a score: CHIMERA's `plan_song` through the same word-timed,
/// pitch-curved layer 2 that speech uses (`score::from_plan`), with `Score::vibrato` added:
/// `plan_song`'s vibrato is a separate control from pitch (the glottis's own LFO depth, not part
/// of the sampled F0 curve), so it would otherwise be silently lost on the way to a score and back
/// through `plan_from_score` (see that function and `Score::vibrato`'s doc comment).
pub fn sing(g2p: &EnglishG2P, request: &SingRequest) -> Result<Score, String> {
    request.validate()?;
    let syllables = lyrics_to_syllables(&request.lyrics, g2p);
    if syllables.is_empty() {
        return Err("nothing to sing: the lyrics have no syllables".into());
    }
    if syllables.len() != request.notes.len() {
        return Err(format!(
            "notes.len() ({}) must equal the lyrics' syllable count ({})",
            request.notes.len(),
            syllables.len()
        ));
    }
    let mix = request.body.mix();
    let notes: Vec<SungNote> = request
        .notes
        .iter()
        .zip(syllables)
        .map(|(n, syl)| SungNote {
            midi: n.midi,
            beats: n.beats,
            syl,
        })
        .collect();
    let plan = plan_song(
        &notes,
        &SongOptions {
            body: mix,
            bpm: request.bpm,
            t0: request.t0,
            vibrato: request.vibrato,
        },
    );
    if plan.gestures.len() > GestureScore::CAPACITY {
        return Err("melody too long for one utterance: split it into phrases".into());
    }
    // The first syllable's onset (if any) sounds before its note's beat: t0 must leave room for
    // it, or plan_song's own first segment lands before t=0, which a Score cannot express
    // (score::validate refuses a negative span). Caught here with a usable message instead of
    // surfacing deep in plan_from_score's generic "invalid or overlapping span" error.
    if let Some(first) = plan.segments.first()
        && first.t0 < 0.0
    {
        return Err(format!(
            "t0 ({:.3}) is too small: the first syllable's onset needs to start at {:.3}s; raise t0 by at least {:.3}s",
            request.t0, first.t0, -first.t0
        ));
    }
    let f0 = midi_to_hz(notes[0].midi);
    let mut score = crate::score::from_plan(&plan, &[], f0);
    score.words = word_spans(&notes, &plan);
    score.vibrato = Some(sample_source(&plan, ControlKey::VIBRATO, score.duration));
    Ok(score)
}
