use intone_chimera::{Request, SAMPLE_RATE, Speaker};

fn request(json: &str) -> Request {
    serde_json::from_str(json).unwrap()
}

fn render(speaker: &Speaker, json: &str, chunk: usize) -> Vec<f32> {
    let mut utterance = speaker.utterance(&request(json)).unwrap();
    let mut out = vec![0.0; utterance.total_samples()];
    let mut at = 0;
    while at < out.len() {
        let end = (at + chunk).min(out.len());
        at += utterance.render(&mut out[at..end]);
    }
    assert_eq!(
        utterance.render(&mut [0.0; 16]),
        0,
        "a finished utterance renders nothing"
    );
    out
}

#[test]
fn speech_is_audible_and_bounded() {
    let out = render(&Speaker::new(), r#"{"text":"Hello there."}"#, 4096);
    assert!(out.len() as f64 > 0.3 * SAMPLE_RATE);
    let peak = out.iter().fold(0f32, |m, x| m.max(x.abs()));
    assert!(peak > 0.01, "silent render: peak {peak}");
    assert!(out.iter().all(|x| x.is_finite()));
}

#[test]
fn output_does_not_depend_on_chunk_size() {
    let speaker = Speaker::new();
    let json = r#"{"text":"The quick fox.","body":"female"}"#;
    // Callers pick the chunk size, so it needn't be a multiple of the engine's block.
    let whole = render(&speaker, json, 4096);
    for chunk in [128 * 3, 128, 97, 1000] {
        assert_eq!(whole, render(&speaker, json, chunk), "chunk size {chunk}");
    }
}

#[test]
fn speech_is_audible_within_a_few_milliseconds() {
    let speaker = Speaker::new();
    for text in [
        "Yes.",
        "Hello there.",
        "Pack the box.",
        "Stop it now.",
        "Many men.",
        "Apple pie.",
        "Under the bridge.",
    ] {
        let out = render(&speaker, &format!(r#"{{"text":"{text}"}}"#), 4096);
        let first = out.iter().position(|x| x.abs() > 1e-3).unwrap();
        let ms = first as f64 / SAMPLE_RATE * 1000.0;
        assert!(ms < 30.0, "{text:?} is silent for {ms:.1} ms");
    }
}

#[test]
fn the_same_request_gives_the_same_samples() {
    let speaker = Speaker::new();
    let json = r#"{"text":"Same again.","body":{"female":0.5,"child":0.25},"rate":1.2}"#;
    assert_eq!(render(&speaker, json, 4096), render(&speaker, json, 4096));
}

#[test]
fn options_change_the_sound() {
    let speaker = Speaker::new();
    let base = render(&speaker, r#"{"text":"Hello there."}"#, 4096);
    let faster = render(&speaker, r#"{"text":"Hello there.","rate":1.5}"#, 4096);
    assert!(
        faster.len() < base.len(),
        "rate must shorten: {} vs {}",
        faster.len(),
        base.len()
    );
    let higher = render(&speaker, r#"{"text":"Hello there.","f0":180}"#, 4096);
    assert_ne!(base, higher);
}

#[test]
fn bad_requests_are_refused() {
    let speaker = Speaker::new();
    for (json, needle) in [
        (r#"{"text":"Hi","rate":0}"#, "rate"),
        (r#"{"text":"Hi","f0":1}"#, "f0"),
        (r#"{"text":"Hi","accent":9}"#, "accent"),
        (
            r#"{"text":"Hi","body":{"female":2,"child":0}}"#,
            "body.female",
        ),
        (r#"{"text":"   "}"#, "nothing to say"),
    ] {
        let error = speaker.utterance(&request(json)).err().unwrap_or_default();
        assert!(error.contains(needle), "{json}: {error:?}");
    }
    assert!(
        serde_json::from_str::<Request>(r#"{"text":"Hi","speed":2}"#).is_err(),
        "unknown fields are refused"
    );
}

#[test]
fn text_too_long_for_the_score_is_refused_not_truncated() {
    let text = "The birch canoe slid on the smooth planks. ".repeat(400);
    let json = serde_json::json!({ "text": text }).to_string();
    let error = Speaker::new()
        .utterance(&request(&json))
        .err()
        .unwrap_or_default();
    assert!(error.contains("too long"), "{error:?}");
}

#[test]
fn the_abi_reports_errors_and_renders() {
    use intone_chimera::abi::*;
    unsafe {
        let s = ic_speaker_new();
        let bad = br#"{"text":"Hi","rate":0}"#;
        assert!(ic_utterance_new(s, bad.as_ptr(), bad.len()).is_null());
        let message = std::slice::from_raw_parts(ic_speaker_error_ptr(s), ic_speaker_error_len(s));
        assert!(String::from_utf8_lossy(message).contains("rate"));

        let good = br#"{"text":"Hi."}"#;
        let u = ic_utterance_new(s, good.as_ptr(), good.len());
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
