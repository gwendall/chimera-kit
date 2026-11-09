//! Tests for singing (`src/sing.rs`): lyrics and notes into a score, word spans named from the
//! lyrics, and the round trip `plan_song -> Score -> plan_from_score` against rendering
//! `plan_song`'s own `Plan` directly (the question lot 7a asks: does the score lose anything).

use chimera::anatomy::human::{BodyMix, BodyName};
use chimera::control::score::{ControlKey, GestureScore};
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::sing::{SongOptions, SungNote, midi_to_hz, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;
use chimera::voice::human_voice::{HumanVoice, SourcePatch};
use intone_chimera::sing::{NoteInput, SingRequest, sing};
use intone_chimera::{SAMPLE_RATE, score};

/// Mirrors `intone_chimera::OVERSAMPLE` (private): the airway steps per output sample.
const OVERSAMPLE: usize = 2;

fn dict(entries: &str) -> EnglishG2P {
    let mut g = EnglishG2P::new();
    g.load_dict(entries);
    g
}

fn vowels_g2p() -> EnglishG2P {
    dict("ah\tAA1\nee\tIY1\noo\tUW1\n")
}

fn notes(midis: &[f64], beats: f64) -> Vec<NoteInput> {
    midis
        .iter()
        .map(|&midi| NoteInput { midi, beats })
        .collect()
}

fn request(
    lyrics: &str,
    midis: &[f64],
    beats: f64,
    bpm: f64,
    vibrato: f64,
    t0: f64,
) -> SingRequest {
    serde_json::from_value(serde_json::json!({
        "lyrics": lyrics,
        "notes": notes(midis, beats).iter().map(|n| serde_json::json!({"midi": n.midi, "beats": n.beats})).collect::<Vec<_>>(),
        "bpm": bpm,
        "vibrato": vibrato,
        "t0": t0,
    }))
    .unwrap()
}

// --- validation: every bad request is refused, naming the offending field --------------------

#[test]
fn notes_must_match_the_lyrics_syllable_count() {
    let g = vowels_g2p();
    let req = request("ah ee oo", &[60.0, 64.0], 1.0, 100.0, 0.0, 0.0);
    let error = sing(&g, &req).err().unwrap();
    assert!(error.contains("notes.len() (2)"), "{error:?}");
    assert!(error.contains("syllable count (3)"), "{error:?}");
}

#[test]
fn bad_requests_are_refused() {
    let g = vowels_g2p();
    for (json, needle) in [
        (
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":1}],"bpm":0}"#,
            "bpm",
        ),
        (
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":1}],"bpm":500}"#,
            "bpm",
        ),
        (
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":1}],"bpm":100,"vibrato":-1}"#,
            "vibrato",
        ),
        (
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":1}],"bpm":100,"vibrato":500}"#,
            "vibrato",
        ),
        (
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":1}],"bpm":100,"t0":-1}"#,
            "t0",
        ),
        (r#"{"lyrics":"ah","notes":[],"bpm":100}"#, "notes"),
        (
            r#"{"lyrics":"ah","notes":[{"midi":200,"beats":1}],"bpm":100}"#,
            "midi",
        ),
        (
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":0}],"bpm":100}"#,
            "beats",
        ),
        (
            r#"{"lyrics":"   ","notes":[{"midi":60,"beats":1}],"bpm":100}"#,
            "nothing to sing",
        ),
    ] {
        let req: SingRequest = serde_json::from_str(json).unwrap();
        let error = sing(&g, &req).err().unwrap_or_default();
        assert!(error.contains(needle), "{json}: {error:?}");
    }
    assert!(
        serde_json::from_str::<SingRequest>(
            r#"{"lyrics":"ah","notes":[{"midi":60,"beats":1}],"bpm":100,"tempo":1.0}"#
        )
        .is_err(),
        "unknown fields are refused"
    );
}

// --- word spans: named from the lyrics, melisma holds extend the previous word's span ----------

fn consonant_g2p() -> EnglishG2P {
    dict("bah\tB AA1\ndee\tD IY1\nbop\tB AA1 P\ntwin\tT W IH1 N\nkle\tK AH0 L\n")
}

#[test]
fn t0_too_small_for_the_first_onset_is_refused_with_a_usable_message() {
    let g = consonant_g2p();
    // "bah" starts with a consonant onset that needs lead time before its note's beat; t0=0
    // would otherwise land it before t=0, which a Score cannot express.
    let req = request("bah", &[60.0], 1.0, 120.0, 0.0, 0.0);
    let error = sing(&g, &req).err().unwrap();
    assert!(error.contains("t0 (0.000) is too small"), "{error:?}");
}

#[test]
fn without_a_t0_a_song_that_starts_on_a_consonant_starts_at_time_zero() {
    // With t0 defaulting to 0, every song starting on a consonant was refused: "Twinkle" included.
    let g = consonant_g2p();
    let req: SingRequest = serde_json::from_value(serde_json::json!({
        "lyrics": "bah", "notes": [{"midi": 60, "beats": 1}], "bpm": 120,
    }))
    .unwrap();
    let score = sing(&g, &req).unwrap();
    let first = score.sounds.iter().find(|s| s.sound != "_").unwrap();
    assert_eq!(first.sound, "b");
    assert!((0.0..0.001).contains(&first.t0), "{:?}", &score.sounds[..2]);
}

#[test]
fn word_spans_name_the_lyric_words_and_cover_their_notes() {
    let g = consonant_g2p();
    let req = request("bah dee bop", &[60.0, 62.0, 64.0], 1.0, 120.0, 0.0, 0.2);
    let score = sing(&g, &req).unwrap();
    let words = score.words.expect("word spans should recover cleanly");
    let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["bah", "dee", "bop"]);
    let mut end = 0.0;
    for w in &words {
        assert!(w.t0 >= end - 1e-9, "words overlap: {w:?}");
        assert!(w.t1 > w.t0);
        end = w.t1;
    }
}

#[test]
fn a_melisma_mark_holds_the_previous_words_span_onto_its_note() {
    let g = consonant_g2p();
    // "bah" is held over its own note and a melisma note before "dee" begins: 3 notes, 2 words.
    let req = request("bah ~ dee", &[60.0, 60.0, 64.0], 1.0, 120.0, 0.0, 0.2);
    let score = sing(&g, &req).unwrap();
    let words = score.words.expect("word spans should recover cleanly");
    let texts: Vec<&str> = words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, ["bah", "dee"]);
    // "bah"'s span covers both its own note and the melisma note that holds it.
    let beat = 60.0 / 120.0;
    assert!(
        words[0].t1 > 0.2 + 1.5 * beat,
        "\"bah\"'s span ({:.3}-{:.3}) should reach past its melisma note",
        words[0].t0,
        words[0].t1
    );
    assert!(words[0].t1 <= words[1].t0 + 1e-9);
}

#[test]
fn a_typed_hyphen_splits_one_word_across_two_notes() {
    let g = consonant_g2p();
    let req = request("twin-kle", &[60.0, 64.0], 1.0, 120.0, 0.0, 0.2);
    let score = sing(&g, &req).unwrap();
    let words = score.words.expect("word spans should recover cleanly");
    assert_eq!(
        words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
        ["twinkle"]
    );
}

// --- the ABI's sing path, end to end ------------------------------------------------------------

#[test]
fn the_abi_sings_and_renders_a_score() {
    use intone_chimera::abi::*;
    unsafe {
        let s = ic_speaker_new();
        let dict = b"bah\tB AA1\ndee\tD IY1\n";
        assert_eq!(ic_speaker_load_dictionary(s, dict.as_ptr(), dict.len()), 1);

        let good = br#"{"lyrics":"bah dee","notes":[{"midi":60,"beats":1},{"midi":64,"beats":1}],"bpm":120,"t0":0.3}"#;
        assert_eq!(ic_speaker_sing(s, good.as_ptr(), good.len()), 1);
        let ptr = ic_speaker_plan_ptr(s);
        let len = ic_speaker_plan_len(s);
        let json = String::from_utf8(std::slice::from_raw_parts(ptr, len).to_vec()).unwrap();
        let score: score::Score = serde_json::from_str(&json).unwrap();
        assert!(!score.sounds.is_empty());
        assert!(
            score.vibrato.is_some(),
            "a sung score always carries a vibrato curve"
        );

        let bad = br#"{"lyrics":"bah dee","notes":[{"midi":60,"beats":1}],"bpm":120}"#;
        assert_eq!(ic_speaker_sing(s, bad.as_ptr(), bad.len()), 0);
        let message = std::slice::from_raw_parts(ic_speaker_error_ptr(s), ic_speaker_error_len(s));
        assert!(String::from_utf8_lossy(message).contains("syllable count"));

        let request = serde_json::json!({ "score": score }).to_string();
        let bytes = request.as_bytes();
        let u = ic_utterance_new_from_score(s, bytes.as_ptr(), bytes.len());
        if u.is_null() {
            let message =
                std::slice::from_raw_parts(ic_speaker_error_ptr(s), ic_speaker_error_len(s));
            panic!(
                "ic_utterance_new_from_score refused the sung score: {}",
                String::from_utf8_lossy(message)
            );
        }
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

// --- fidelity: plan_song -> Score -> plan_from_score, against rendering the Plan directly ------

struct Melody {
    g2p: EnglishG2P,
    notes: Vec<SungNote>,
    opt: SongOptions,
}

/// Four pure-vowel notes (no onset or coda consonants, so every note is exactly one planned
/// segment) across two phrases ("ah ee," / "oo ah."): long enough for vibrato to bloom (quarter
/// second) and settle well before each note ends.
fn two_phrase_melody() -> Melody {
    let g2p = vowels_g2p();
    let lyrics = "ah ee, oo ah.";
    let syl = lyrics_to_syllables(lyrics, &g2p);
    assert_eq!(syl.len(), 4);
    let midis = [57.0, 60.0, 64.0, 67.0];
    let notes: Vec<SungNote> = syl
        .into_iter()
        .zip(midis)
        .map(|(syl, midi)| SungNote {
            midi,
            beats: 2.0,
            syl,
        })
        .collect();
    let opt = SongOptions {
        body: BodyName::Male.into(),
        bpm: 100.0,
        t0: 0.3,
        vibrato: 50.0,
    };
    Melody { g2p, notes, opt }
}

/// Each note's beat-landing time, the same cumulative formula `plan_song` uses internally.
fn note_times(m: &Melody) -> Vec<f64> {
    let beat = 60.0 / m.opt.bpm;
    let mut t = m.opt.t0;
    m.notes
        .iter()
        .map(|n| {
            let here = t;
            t += n.beats * beat;
            here
        })
        .collect()
}

fn render(
    plan: &chimera::phonetics::Plan,
    mix: BodyMix,
    f0: f64,
    tension: Option<f64>,
    samples: usize,
) -> Vec<f32> {
    let mut voice = HumanVoice::new(SAMPLE_RATE, mix.body(), OVERSAMPLE);
    let mut patch = SourcePatch::f0(f0);
    patch.tension = tension;
    voice.set_source(&patch);
    voice.schedule(&plan.gestures);
    let mut out = vec![0.0f32; samples];
    for block in out.chunks_mut(128) {
        voice.render(block);
    }
    out
}

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

fn cents(a: f64, b: f64) -> f64 {
    1200.0 * (a / b).log2()
}

/// Median spectral difference (dB, mean |Δ| per frame) between two equal-length renders, over a
/// `[win]`-sample Hann window, hop `hop`.
fn spectral_median_diff(a: &[f32], b: &[f32], win: usize, hop: usize) -> f64 {
    use chimera::analysis::fft::{Fft, hann, power_spectrum_db};
    let fft = Fft::new(win);
    let window = hann(win);
    let n = a.len().min(b.len());
    let mut diffs = Vec::new();
    let mut i = 0;
    while i + win <= n {
        let fa: Vec<f64> = a[i..i + win].iter().map(|x| f64::from(*x)).collect();
        let fb: Vec<f64> = b[i..i + win].iter().map(|x| f64::from(*x)).collect();
        let sa = power_spectrum_db(&fa, &fft, &window);
        let sb = power_spectrum_db(&fb, &fft, &window);
        let mad: f64 =
            sa.iter().zip(&sb).map(|(x, y)| (x - y).abs()).sum::<f64>() / sa.len() as f64;
        diffs.push(mad);
        i += hop;
    }
    diffs.sort_by(f64::total_cmp);
    diffs[diffs.len() / 2]
}

#[test]
fn score_sound_boundaries_keep_plan_songs_exact_timing() {
    let m = two_phrase_melody();
    let direct = plan_song(&m.notes, &m.opt);

    let req = request(
        "ah ee, oo ah.",
        &[57.0, 60.0, 64.0, 67.0],
        2.0,
        100.0,
        50.0,
        0.3,
    );
    let score = sing(&m.g2p, &req).unwrap();
    let mix: BodyMix = BodyName::Male.into();
    let (roundtrip, _tension) = score::plan_from_score(&score, mix).unwrap();

    assert_eq!(direct.segments.len(), roundtrip.segments.len());
    let mut worst_ms = 0.0f64;
    for (a, b) in direct.segments.iter().zip(&roundtrip.segments) {
        worst_ms = worst_ms
            .max((a.t0 - b.t0).abs() * 1000.0)
            .max((a.t1 - b.t1).abs() * 1000.0);
    }
    // Score.sounds boundaries are copied verbatim from plan_song's own segments (JSON floats
    // round-trip exactly: Cargo.toml's serde_json "float_roundtrip"), and plan_from_score replays
    // them with the same explicit durations from the same start: onset timing error is ~0, not
    // an approximation.
    assert!(
        worst_ms < 1e-6,
        "worst onset/offset timing error {worst_ms} ms"
    );
}

#[test]
fn breath_between_phrases_survives_the_round_trip_where_it_sounds() {
    let m = two_phrase_melody();
    let direct = plan_song(&m.notes, &m.opt);

    let req = request(
        "ah ee, oo ah.",
        &[57.0, 60.0, 64.0, 67.0],
        2.0,
        100.0,
        50.0,
        0.3,
    );
    let score = sing(&m.g2p, &req).unwrap();
    let mix: BodyMix = BodyName::Male.into();
    let (roundtrip, _tension) = score::plan_from_score(&score, mix).unwrap();

    let mut direct_board = GestureScore::new();
    direct_board.add_all(&direct.gestures);
    let mut roundtrip_board = GestureScore::new();
    roundtrip_board.add_all(&roundtrip.gestures);

    // The one silence gap plan_song leaves between the two phrases, read off its own segments
    // (not re-derived by hand: `score_sound_boundaries_keep_plan_songs_exact_timing` already
    // proves the round-tripped plan's segments land at the same times).
    let (gap_t0, gap_t1) = direct
        .segments
        .windows(2)
        .find_map(|w| (w[1].t0 - w[0].t1 > 1e-6).then(|| (w[0].t1, w[1].t0)))
        .expect("the two-phrase melody should leave exactly one inter-phrase gap");

    let at = |board: &GestureScore, t: f64| board.blend(ControlKey::BREATH, t).value;
    let before = (
        at(&direct_board, gap_t0 - 0.03),
        at(&roundtrip_board, gap_t0 - 0.03),
    );
    let after = (
        at(&direct_board, gap_t1 + 0.03),
        at(&roundtrip_board, gap_t1 + 0.03),
    );
    let mid = (
        at(&direct_board, (gap_t0 + gap_t1) / 2.0),
        at(&roundtrip_board, (gap_t0 + gap_t1) / 2.0),
    );
    println!(
        "breath around the {:.3}s gap: before (still sounding) direct {:.3} round-trip {:.3}; \
         mid-gap (silent) direct {:.3} round-trip {:.3}; after (sounding again) direct {:.3} round-trip {:.3}",
        gap_t1 - gap_t0,
        before.0,
        before.1,
        mid.0,
        mid.1,
        after.0,
        after.1
    );

    // Where the note is actually sounding, just before and after the gap, breath should round
    // trip closely: this is the part a listener hears.
    assert!(
        (before.0 - before.1).abs() < 0.05,
        "breath just before the gap: direct {:.3}, round-trip {:.3}",
        before.0,
        before.1
    );
    assert!(
        (after.0 - after.1).abs() < 0.05,
        "breath just after the gap: direct {:.3}, round-trip {:.3}",
        after.0,
        after.1
    );

    // Inside the gap itself, plan_from_score deliberately forces breath to 0 under any silence
    // (score.rs: "must not sustain phonation through unlabelled gaps", ported from chimera-lab's
    // performance.rs) regardless of what the measured curve says there: this is a known, existing
    // round-trip difference from plan_song's own breath (which may still be mid-release this
    // close to the phrase edges), not something this lot introduces or should change.
    assert!(
        mid.1.abs() < 1e-9,
        "round-tripped breath mid-gap should be forced to 0, got {:.3}",
        mid.1
    );
}

#[test]
fn pitch_and_vibrato_survive_the_round_trip_but_are_lost_without_the_vibrato_curve() {
    let m = two_phrase_melody();
    let direct_plan = plan_song(&m.notes, &m.opt);
    let times = note_times(&m);
    let mix: BodyMix = BodyName::Male.into();
    let f0 = midi_to_hz(m.notes[0].midi);

    let req = request(
        "ah ee, oo ah.",
        &[57.0, 60.0, 64.0, 67.0],
        2.0,
        100.0,
        50.0,
        0.3,
    );
    let score = sing(&m.g2p, &req).unwrap();
    assert!(score.vibrato.is_some());

    let samples = ((direct_plan.end + 0.6) * SAMPLE_RATE).round() as usize;
    let direct_audio = render(&direct_plan, mix, f0, None, samples);

    let (with_vibrato_plan, tension) = score::plan_from_score(&score, mix).unwrap();
    let with_vibrato_audio = render(&with_vibrato_plan, mix, f0, tension, samples);

    let mut without_vibrato = score.clone();
    without_vibrato.vibrato = None;
    let (without_vibrato_plan, tension2) = score::plan_from_score(&without_vibrato, mix).unwrap();
    let without_vibrato_audio = render(&without_vibrato_plan, mix, f0, tension2, samples);

    // Per note, over the vibrato's steady region (it blooms over its first ~0.52 s): median and
    // worst absolute cents error of a YIN track against the direct render's own track, at
    // matching times (this measures round-trip fidelity against the engine's own output, not
    // against an idealized sine).
    let beat = 2.0 * 60.0 / m.opt.bpm; // 1.2 s per note at bpm 100, beats 2
    let direct_track = f0_track(&direct_audio, 512, 64);
    let with_track = f0_track(&with_vibrato_audio, 512, 64);
    let without_track = f0_track(&without_vibrato_audio, 512, 64);

    // median, 90th percentile and true worst; the worst alone is dominated by YIN's own
    // occasional octave misfire on a vibrato'd tone (common to any pitch tracker), not by the
    // round trip, so the assertions below use the 90th percentile.
    let region_errors = |other: &[(f64, Option<f64>)]| -> (f64, f64, f64) {
        let mut errs = Vec::new();
        for &k0 in &times {
            let lo = k0 + 0.6;
            let hi = k0 + beat - 0.05;
            for (&(t, d), &(_, o)) in direct_track.iter().zip(other) {
                if t < lo || t > hi {
                    continue;
                }
                if let (Some(d), Some(o)) = (d, o) {
                    errs.push(cents(o, d).abs());
                }
            }
        }
        errs.sort_by(f64::total_cmp);
        let worst = *errs.last().unwrap_or(&0.0);
        let p90 = errs[(errs.len() * 9 / 10).min(errs.len() - 1)];
        let median = errs[errs.len() / 2];
        (median, p90, worst)
    };

    let (with_median, with_p90, with_worst) = region_errors(&with_track);
    let (without_median, without_p90, without_worst) = region_errors(&without_track);

    println!(
        "pitch+vibrato round-trip cents error: with vibrato curve median {with_median:.1} p90 {with_p90:.1} worst {with_worst:.1}; \
         without it (vibrato stripped from the score) median {without_median:.1} p90 {without_p90:.1} worst {without_worst:.1}"
    );

    // With the vibrato curve, the round trip should track the direct render's own oscillation
    // closely (headroom over YIN's own jitter on a vibrato'd tone, not over engine noise).
    assert!(
        with_median < 15.0,
        "with vibrato: median cents error {with_median:.1}"
    );
    assert!(
        with_p90 < 60.0,
        "with vibrato: p90 cents error {with_p90:.1}"
    );
    // Without it, the round trip renders a flat note where the direct render has a ~50-cent-deep
    // 6 Hz wobble: the two should disagree by a sizeable fraction of the vibrato depth, proving
    // the field (not noise) is what closes the gap above.
    assert!(
        without_median > with_median * 2.0,
        "stripping the vibrato curve should make the round trip measurably worse: with {with_median:.1}, without {without_median:.1}"
    );

    let spectral_with = spectral_median_diff(&direct_audio, &with_vibrato_audio, 1024, 512);
    let spectral_without = spectral_median_diff(&direct_audio, &without_vibrato_audio, 1024, 512);
    println!(
        "spectral median |dB diff| vs direct: with vibrato {spectral_with:.2}, without {spectral_without:.2}"
    );
    assert!(
        spectral_with < spectral_without,
        "carrying vibrato should match the direct render's spectrum more closely"
    );
}
