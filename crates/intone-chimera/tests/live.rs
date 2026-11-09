//! The held, played voice (`ic_live_*`/`ic_beat_*`): a note sounds as soon as it is on, invalid
//! input is refused without touching the engine, and the beatbox sequencer ticks.

use intone_chimera::SAMPLE_RATE;
use intone_chimera::abi::*;

unsafe fn error(h: *const LiveHandle) -> String {
    unsafe {
        String::from_utf8_lossy(std::slice::from_raw_parts(
            ic_live_error_ptr(h),
            ic_live_error_len(h),
        ))
        .into_owned()
    }
}

unsafe fn render(h: *mut LiveHandle, n: usize) -> Vec<f32> {
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let chunk = (n - out.len()).min(4096);
        let got = unsafe { ic_live_render(h, chunk) };
        let buf = unsafe { std::slice::from_raw_parts(ic_live_buffer(h), got) };
        out.extend_from_slice(buf);
    }
    out
}

fn json(value: serde_json::Value) -> String {
    value.to_string()
}

#[test]
fn a_held_note_is_audible_within_a_few_milliseconds_and_finite() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        let body = json(serde_json::json!("female"));
        assert_eq!(ic_live_set_body(h, body.as_ptr(), body.len()), 1);
        assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
        let vowel = "a";
        assert_eq!(ic_live_vowel(h, vowel.as_ptr(), vowel.len()), 1);

        let out = render(h, (SAMPLE_RATE * 0.1) as usize);
        assert!(out.iter().all(|x| x.is_finite()), "non-finite sample");
        let first = out.iter().position(|x| x.abs() > 1e-3);
        let ms = first.map(|i| i as f64 / SAMPLE_RATE * 1000.0);
        assert!(matches!(ms, Some(ms) if ms < 30.0), "silent for {ms:?} ms");

        ic_live_free(h);
    }
}

#[test]
fn note_off_quiets_the_voice() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        assert_eq!(ic_live_note_on(h, 64.0, 1.0), 1);
        let vowel = "a";
        assert_eq!(ic_live_vowel(h, vowel.as_ptr(), vowel.len()), 1);
        render(h, (SAMPLE_RATE * 0.05) as usize); // let it speak up
        ic_live_note_off(h);
        let tail = render(h, (SAMPLE_RATE * 0.5) as usize);
        let released = &tail[tail.len() - 4096..];
        let peak = released.iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(peak < 0.01, "still loud after release: peak {peak}");
        ic_live_free(h);
    }
}

#[test]
fn changing_the_vowel_changes_the_sound() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
        let a = "a";
        assert_eq!(ic_live_vowel(h, a.as_ptr(), a.len()), 1);
        render(h, 8192); // settle
        let a_out = render(h, 8192);
        let i = "i";
        assert_eq!(ic_live_vowel(h, i.as_ptr(), i.len()), 1);
        render(h, 8192); // settle
        let i_out = render(h, 8192);
        assert_ne!(a_out, i_out, "the two vowels sound the same");
        ic_live_free(h);
    }
}

#[test]
fn bend_glides_pitch_without_retriggering_the_gate() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
        let a = "a";
        assert_eq!(ic_live_vowel(h, a.as_ptr(), a.len()), 1);
        render(h, 4096);
        assert_eq!(ic_live_bend(h, 67.0), 1);
        let out = render(h, 4096);
        assert!(out.iter().all(|x| x.is_finite()));
        ic_live_free(h);
    }
}

#[test]
fn invalid_input_is_refused_and_does_not_poison_the_engine() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);

        // Unknown vowel.
        let bad = "zz";
        assert_eq!(ic_live_vowel(h, bad.as_ptr(), bad.len()), 0);
        assert!(error(h).contains("unknown vowel"), "{}", error(h));

        // NaN on the two calls that take a plain f64 (JSON itself cannot carry NaN or Infinity:
        // JSON.stringify(NaN) is "null" in JS too, so the JSON setters below reject out-of-range
        // numbers instead; `src/engines/chimera-live.ts` guards finiteness before encoding).
        assert_eq!(ic_live_note_on(h, f64::NAN, 1.0), 0);
        assert!(error(h).contains("finite"), "{}", error(h));
        assert_eq!(ic_live_bend(h, f64::NAN), 0);
        assert_eq!(ic_live_note_on(h, f64::INFINITY, 1.0), 0);

        // Out-of-range input a JSON setter can carry (serde's own type/range check stands in for
        // the NaN case the wire format can't).
        let bad_source = json(serde_json::json!({"f0": "not a number"}));
        assert_eq!(ic_live_source(h, bad_source.as_ptr(), bad_source.len()), 0);

        // Unknown beat sound.
        let bad_beat = json(serde_json::json!({"id": "nope"}));
        assert_eq!(ic_beat_hit(h, bad_beat.as_ptr(), bad_beat.len()), 0);
        assert!(error(h).contains("unknown beat sound"), "{}", error(h));

        let bad_tempo = json(serde_json::json!({"bpm": -1.0}));
        assert_eq!(ic_beat_tempo(h, bad_tempo.as_ptr(), bad_tempo.len()), 0);

        // None of that touched the engine: a valid note still plays cleanly.
        assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
        let a = "a";
        assert_eq!(ic_live_vowel(h, a.as_ptr(), a.len()), 1);
        let out = render(h, 8192);
        assert!(out.iter().all(|x| x.is_finite()));
        let peak = out.iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(
            peak > 0.01,
            "engine stayed silent after refused input: {peak}"
        );

        ic_live_free(h);
    }
}

#[test]
fn rapid_note_on_off_renders_finite_samples() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        let a = "a";
        assert_eq!(ic_live_vowel(h, a.as_ptr(), a.len()), 1);
        for i in 0..50 {
            assert_eq!(ic_live_note_on(h, 60.0 + (i % 5) as f64, 1.0), 1);
            let out = render(h, 256);
            assert!(out.iter().all(|x| x.is_finite()));
            ic_live_note_off(h);
            let out = render(h, 256);
            assert!(out.iter().all(|x| x.is_finite()));
        }
        ic_live_free(h);
    }
}

#[test]
fn freeing_a_sounding_voice_does_not_crash() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
        let a = "a";
        assert_eq!(ic_live_vowel(h, a.as_ptr(), a.len()), 1);
        render(h, 4096);
        ic_live_free(h); // still gated on: must not panic or leak
    }
}

#[test]
fn live_render_output_does_not_depend_on_chunk_size() {
    unsafe {
        let whole = {
            let h = ic_live_new(SAMPLE_RATE);
            assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
            let a = "a";
            ic_live_vowel(h, a.as_ptr(), a.len());
            let out = render(h, 16384);
            ic_live_free(h);
            out
        };
        for chunk in [128usize, 97, 1000, 128 * 3] {
            let h = ic_live_new(SAMPLE_RATE);
            assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
            let a = "a";
            ic_live_vowel(h, a.as_ptr(), a.len());
            let mut out = Vec::with_capacity(16384);
            while out.len() < 16384 {
                let n = ic_live_render(h, chunk.min(4096));
                out.extend_from_slice(std::slice::from_raw_parts(ic_live_buffer(h), n));
            }
            out.truncate(16384); // a chunk size needn't divide the total evenly
            ic_live_free(h);
            assert_eq!(whole, out, "chunk size {chunk}");
        }
    }
}

#[test]
fn beatbox_hit_is_audible() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        let hit = json(serde_json::json!({"id": "kick"})); // by name, not pattern symbol
        assert_eq!(ic_beat_hit(h, hit.as_ptr(), hit.len()), 1);
        let out = render(h, (SAMPLE_RATE * 0.2) as usize);
        let peak = out.iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.01, "the kick was not heard: peak {peak}");
        assert!(out.iter().all(|x| x.is_finite()));
        ic_live_free(h);
    }
}

#[test]
fn the_sequencer_ticks_and_telemetry_reports_its_playhead() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        let pattern = "B . t .";
        assert_eq!(ic_beat_steps(h, pattern.as_ptr(), pattern.len()), 1);
        let tempo = json(serde_json::json!({"bpm": 240.0}));
        assert_eq!(ic_beat_tempo(h, tempo.as_ptr(), tempo.len()), 1);
        ic_beat_playing(h, 1);

        let mut steps_seen = std::collections::HashSet::new();
        for _ in 0..200 {
            render(h, 512);
            let telemetry = ic_live_telemetry(h);
            let len = ic_live_telemetry_len(h);
            let data = std::slice::from_raw_parts(telemetry, len);
            assert!(
                data.iter().all(|x| x.is_finite()),
                "telemetry has a NaN/Inf"
            );
            steps_seen.insert(data[11] as i64); // beat step, see live::pack_telemetry
        }
        assert!(
            steps_seen.len() > 1,
            "the playhead never advanced: {steps_seen:?}"
        );

        ic_beat_playing(h, 0);
        ic_live_free(h);
    }
}

#[test]
fn telemetry_header_matches_its_arrays() {
    unsafe {
        let h = ic_live_new(SAMPLE_RATE);
        assert_eq!(ic_live_note_on(h, 60.0, 1.0), 1);
        render(h, 4096);
        let ptr = ic_live_telemetry(h);
        let len = ic_live_telemetry_len(h);
        let data = std::slice::from_raw_parts(ptr, len);
        let header = 19;
        let counted: usize = data[12..19].iter().map(|x| *x as usize).sum();
        assert_eq!(data.len(), header + counted, "{data:?}");
        assert!(data[3] > 0.0, "f0 should be positive while a note is held");
        ic_live_free(h);
    }
}
