//! Tests for layer 2 (`src/score.rs`): planning text into a score, and rendering a score back,
//! with its timing and pitch honored exactly.

use intone_chimera::score::{Score, Sound};
use intone_chimera::{Body, Request, SAMPLE_RATE, ScoreRequest, Speaker};

fn request(json: &str) -> Request {
    serde_json::from_str(json).unwrap()
}

fn render_all(mut render: impl FnMut(&mut [f32]) -> usize, total: usize, chunk: usize) -> Vec<f32> {
    let mut out = vec![0.0; total];
    let mut at = 0;
    while at < out.len() {
        let end = (at + chunk).min(out.len());
        at += render(&mut out[at..end]);
    }
    out
}

fn render_score(speaker: &Speaker, score: Score, chunk: usize) -> Vec<f32> {
    let mut u = speaker
        .utterance_from_score(&ScoreRequest {
            score,
            body: Body::default(),
        })
        .unwrap();
    let total = u.total_samples();
    render_all(|buf| u.render(buf), total, chunk)
}

/// A score with one sound, a sensible duration, and a pitch curve. Callers override what they're
/// testing; everything else stays valid so `validate` doesn't reject it for an unrelated reason.
fn held_vowel(duration: f64, pitch: Vec<[f64; 2]>) -> Score {
    Score {
        duration,
        sounds: vec![Sound {
            sound: "a".into(),
            t0: 0.0,
            t1: duration,
            stress: Some(1),
        }],
        pitch,
        loudness: None,
        breath: None,
        tension: None,
        vibrato: None,
        words: None,
    }
}

// --- round trip: plan from text, render the score back, same sounds and timing -----------------

#[test]
fn a_score_planned_from_text_keeps_the_original_timing_when_rendered() {
    let speaker = Speaker::new();
    let req = request(r#"{"text":"Hello there."}"#);

    let direct = speaker.utterance(&req).unwrap();
    let score = speaker.plan(&req).unwrap();

    // The score's own sounds cover the score's duration exactly, in time order, boundary to
    // boundary (silence included), which is what "render it back and get the same timing" needs.
    assert!(!score.sounds.is_empty());
    let mut end = 0.0;
    for s in &score.sounds {
        assert!(s.t0 >= end - 1e-9, "sounds must not overlap: {s:?}");
        assert!(s.t1 > s.t0);
        end = s.t1;
    }
    assert!(
        (end - score.duration).abs() < 1e-6,
        "sounds must cover the whole score"
    );
    assert!(
        score.sounds.iter().any(|s| s.sound != "_"),
        "something must actually sound"
    );

    let from_score = speaker
        .utterance_from_score(&ScoreRequest {
            score,
            body: Body::default(),
        })
        .unwrap();
    // The planner always adds the same silence tail (TAIL_SECONDS) after the last gesture, so a
    // score round-tripped through rendering keeps the exact same total length.
    assert_eq!(direct.total_samples(), from_score.total_samples());
}

#[test]
fn a_planned_score_recovers_word_boundaries() {
    let speaker = Speaker::new();
    let score = speaker
        .plan(&request(r#"{"text":"Hello there."}"#))
        .unwrap();
    let words = score.words.expect("recoverable from the G2P's own markers");
    let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["hello", "there"]);
    for w in &words {
        assert!(w.t0 < w.t1 && w.t1 <= score.duration);
    }
    assert!(
        words[0].t1 <= words[1].t0 + 1e-9,
        "words are in order and don't overlap"
    );
}

// --- chunk-size independence for score rendering --------------------------------------------

#[test]
fn score_rendering_does_not_depend_on_chunk_size() {
    let speaker = Speaker::new();
    let score = speaker
        .plan(&request(r#"{"text":"The quick fox.","body":"female"}"#))
        .unwrap();
    let whole = render_score(&speaker, score.clone(), 4096);
    for chunk in [128 * 3, 128, 97, 1000] {
        assert_eq!(
            whole,
            render_score(&speaker, score.clone(), chunk),
            "chunk size {chunk}"
        );
    }
}

#[test]
fn a_hand_built_score_with_breath_and_loudness_renders_the_same_regardless_of_chunk_size() {
    let speaker = Speaker::new();
    let score = Score {
        duration: 0.8,
        sounds: vec![
            Sound {
                sound: "a".into(),
                t0: 0.0,
                t1: 0.4,
                stress: Some(1),
            },
            Sound {
                sound: "_".into(),
                t0: 0.4,
                t1: 0.45,
                stress: None,
            },
            Sound {
                sound: "i".into(),
                t0: 0.45,
                t1: 0.8,
                stress: Some(1),
            },
        ],
        pitch: vec![[0.0, 140.0], [0.8, 160.0]],
        loudness: Some(vec![[0.0, 0.0], [0.4, -6.0], [0.8, 0.0]]),
        breath: Some(vec![[0.0, 0.1], [0.4, 0.5], [0.8, 0.1]]),
        tension: Some(vec![[0.0, 0.3]]),
        vibrato: Some(vec![[0.0, 0.0], [0.4, 40.0], [0.8, 40.0]]),
        words: None,
    };
    let whole = render_score(&speaker, score.clone(), 4096);
    assert!(whole.iter().all(|x| x.is_finite()));
    for chunk in [128 * 3, 128, 97, 1000] {
        assert_eq!(
            whole,
            render_score(&speaker, score.clone(), chunk),
            "chunk size {chunk}"
        );
    }
}

// --- pitch conformance: measure what actually came out, not just what was asked for ------------

/// A quick-and-dirty f0 track over a rendered score, one estimate every `hop` samples using a
/// `win`-sample window centered on it. `None` where YIN calls it unvoiced.
fn f0_track(samples: &[f32], win: usize, hop: usize) -> Vec<(f64, Option<f64>)> {
    use chimera::analysis::pitch::yin_pitch;
    let mut out = Vec::new();
    let mut i = 0;
    while i + win <= samples.len() {
        let frame: Vec<f64> = samples[i..i + win].iter().map(|x| f64::from(*x)).collect();
        let p = yin_pitch(&frame, SAMPLE_RATE, Default::default());
        let t = (i as f64 + win as f64 / 2.0) / SAMPLE_RATE;
        out.push((t, if p.f0 > 0.0 { Some(p.f0) } else { None }));
        i += hop;
    }
    out
}

fn cents(measured: f64, expected: f64) -> f64 {
    1200.0 * (measured / expected).log2()
}

#[test]
fn a_held_vowels_pitch_curve_glides_as_asked() {
    let speaker = Speaker::new();
    let duration = 1.0;
    let score = held_vowel(duration, vec![[0.0, 120.0], [duration, 180.0]]);
    let out = render_score(&speaker, score, 4096);

    let track = f0_track(&out, 1024, 256);
    // Skip the first 50 ms: the glottis hasn't settled into voicing yet, and YIN can't be
    // expected to track a note that has only just started.
    let errors: Vec<f64> = track
        .into_iter()
        .filter(|&(t, _)| t > 0.05)
        .filter_map(|(t, f0)| {
            f0.map(|f0| cents(f0, 120.0 + 60.0 * t.min(duration) / duration).abs())
        })
        .collect();
    assert!(
        errors.len() > 50,
        "too few voiced frames to judge: {}",
        errors.len()
    );
    let mut sorted = errors.clone();
    sorted.sort_by(f64::total_cmp);
    let median = sorted[sorted.len() / 2];
    let worst = *sorted.last().unwrap();
    // Measured on this build: median ~28 cents, worst ~44 cents (YIN on a synthetic glide, not
    // engine noise). Thresholds leave headroom rather than pinning the exact numbers.
    assert!(median < 60.0, "median pitch error {median:.1} cents");
    assert!(worst < 120.0, "worst pitch error {worst:.1} cents");
}

#[test]
fn a_held_vowels_pitch_step_lands_on_both_sides() {
    let speaker = Speaker::new();
    let duration = 1.0;
    let step_t = 0.5;
    let score = held_vowel(
        duration,
        vec![
            [0.0, 120.0],
            [step_t, 120.0],
            [step_t + 0.001, 180.0],
            [duration, 180.0],
        ],
    );
    let out = render_score(&speaker, score, 4096);
    let track = f0_track(&out, 1024, 256);

    // Away from onset and from the step's own transition (measured: the glottis takes about
    // 120 ms to settle after a 60 Hz jump), the pitch should sit close to whichever side it's on.
    let before: Vec<f64> = track
        .iter()
        .filter(|&&(t, _)| t > 0.05 && t < step_t - 0.03)
        .filter_map(|&(_, f0)| f0.map(|f0| cents(f0, 120.0).abs()))
        .collect();
    let after: Vec<f64> = track
        .iter()
        .filter(|&&(t, _)| t > step_t + 0.12 && t < duration - 0.02)
        .filter_map(|&(_, f0)| f0.map(|f0| cents(f0, 180.0).abs()))
        .collect();
    assert!(
        before.len() > 10 && after.len() > 10,
        "too few voiced frames: {} / {}",
        before.len(),
        after.len()
    );
    let worst_before = before.iter().cloned().fold(0.0, f64::max);
    let worst_after = after.iter().cloned().fold(0.0, f64::max);
    assert!(
        worst_before < 60.0,
        "before the step: {worst_before:.1} cents off 120 Hz"
    );
    assert!(
        worst_after < 60.0,
        "after the step: {worst_after:.1} cents off 180 Hz"
    );
}

// --- validation: every bad score kind is refused, naming the offending field -------------------

fn score_json(patch: &str) -> String {
    format!(
        r#"{{"score":{{"duration":1.0,"sounds":[{{"sound":"a","t0":0.0,"t1":1.0}}],"pitch":[[0.0,120.0]]{patch}}}}}"#
    )
}

fn refused(json: &str) -> String {
    let req: ScoreRequest = serde_json::from_str(json).unwrap();
    Speaker::new()
        .utterance_from_score(&req)
        .err()
        .unwrap_or_default()
}

#[test]
fn a_bad_duration_is_refused() {
    for (duration, needle) in [("0", "duration"), ("-1", "duration"), ("700", "duration")] {
        let json = format!(
            r#"{{"score":{{"duration":{duration},"sounds":[{{"sound":"a","t0":0.0,"t1":0.5}}],"pitch":[[0.0,120.0]]}}}}"#
        );
        let error = refused(&json);
        assert!(error.contains(needle), "duration {duration}: {error:?}");
    }
}

#[test]
fn empty_sounds_are_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[],"pitch":[[0.0,120.0]]}}"#;
    assert!(refused(json).contains("sounds"));
}

#[test]
fn empty_pitch_is_refused() {
    let json =
        r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.0,"t1":1.0}],"pitch":[]}}"#;
    assert!(refused(json).contains("pitch"));
}

#[test]
fn an_out_of_range_pitch_value_is_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.0,"t1":1.0}],"pitch":[[0.0,5.0]]}}"#;
    assert!(refused(json).contains("pitch"));
}

#[test]
fn an_out_of_range_loudness_value_is_refused() {
    let json = score_json(r#","loudness":[[0.0,100.0]]"#);
    assert!(refused(&json).contains("loudness"));
}

#[test]
fn an_out_of_range_breath_value_is_refused() {
    let json = score_json(r#","breath":[[0.0,2.0]]"#);
    assert!(refused(&json).contains("breath"));
}

#[test]
fn a_tension_curve_that_changes_over_time_is_refused() {
    let json = score_json(r#","tension":[[0.0,0.2],[1.0,0.8]]"#);
    let error = refused(&json);
    assert!(error.contains("tension"), "{error:?}");
    assert!(error.contains("changes over time"), "{error:?}");
}

#[test]
fn a_constant_tension_curve_is_accepted() {
    let json = score_json(r#","tension":[[0.0,0.4],[1.0,0.4]]"#);
    let req: ScoreRequest = serde_json::from_str(&json).unwrap();
    assert!(Speaker::new().utterance_from_score(&req).is_ok());
}

#[test]
fn an_unknown_sound_is_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"qq","t0":0.0,"t1":1.0}],"pitch":[[0.0,120.0]]}}"#;
    let error = refused(json);
    assert!(error.contains("sounds[0]"), "{error:?}");
    assert!(error.contains("unknown"), "{error:?}");
}

#[test]
fn overlapping_sounds_are_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.0,"t1":0.6},{"sound":"i","t0":0.5,"t1":0.9}],"pitch":[[0.0,120.0]]}}"#;
    let error = refused(json);
    assert!(error.contains("sounds[1]"), "{error:?}");
}

#[test]
fn out_of_order_sound_times_are_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.5,"t1":0.3}],"pitch":[[0.0,120.0]]}}"#;
    let error = refused(json);
    assert!(error.contains("sounds[0]"), "{error:?}");
}

#[test]
fn a_bad_stress_value_is_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.0,"t1":1.0,"stress":5}],"pitch":[[0.0,120.0]]}}"#;
    let error = refused(json);
    assert!(error.contains("stress"), "{error:?}");
}

#[test]
fn overlapping_word_spans_are_refused() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.0,"t1":1.0}],"pitch":[[0.0,120.0]],"words":[{"text":"a","t0":0.0,"t1":0.6},{"text":"b","t0":0.5,"t1":0.9}]}}"#;
    let error = refused(json);
    assert!(error.contains("words[1]"), "{error:?}");
}

#[test]
fn an_unknown_score_field_is_refused_at_parse_time() {
    let json = r#"{"score":{"duration":1.0,"sounds":[{"sound":"a","t0":0.0,"t1":1.0}],"pitch":[[0.0,120.0]],"tempo":1.0}}"#;
    assert!(serde_json::from_str::<ScoreRequest>(json).is_err());
}

#[test]
fn a_score_starting_at_t_zero_renders_finite_bounded_audio() {
    // The breath-group chunker pre-rolls 0.06 s before the first sound; a score that starts
    // exactly at t=0 has nowhere to put that pre-roll. It should still render cleanly.
    let speaker = Speaker::new();
    let score = held_vowel(0.3, vec![[0.0, 130.0], [0.3, 130.0]]);
    let out = render_score(&speaker, score, 4096);
    assert!(out.iter().all(|x| x.is_finite()));
    let peak = out.iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(peak > 0.001 && peak < 4.0, "peak {peak}");
}

// --- the ABI's score path, end to end -----------------------------------------------------------

#[test]
fn the_abi_plans_and_renders_a_score() {
    use intone_chimera::abi::*;
    unsafe {
        let s = ic_speaker_new();
        let good = br#"{"text":"Hi there."}"#;
        assert_eq!(ic_speaker_plan(s, good.as_ptr(), good.len()), 1);
        let ptr = ic_speaker_plan_ptr(s);
        let len = ic_speaker_plan_len(s);
        let json = String::from_utf8(std::slice::from_raw_parts(ptr, len).to_vec()).unwrap();
        let score: Score = serde_json::from_str(&json).unwrap();
        assert!(!score.sounds.is_empty());

        let bad = br#"{"text":"Hi","rate":0}"#;
        assert_eq!(ic_speaker_plan(s, bad.as_ptr(), bad.len()), 0);
        let message = std::slice::from_raw_parts(ic_speaker_error_ptr(s), ic_speaker_error_len(s));
        assert!(String::from_utf8_lossy(message).contains("rate"));

        let request = serde_json::json!({ "score": score }).to_string();
        let bytes = request.as_bytes();
        let u = ic_utterance_new_from_score(s, bytes.as_ptr(), bytes.len());
        assert!(!u.is_null());
        let total = ic_utterance_samples(u);
        let mut seen = 0;
        loop {
            let n = ic_utterance_render(u, 4096);
            if n == 0 {
                break;
            }
            seen += n;
        }
        assert_eq!(seen, total);
        ic_utterance_free(u);
        ic_speaker_free(s);
    }
}
