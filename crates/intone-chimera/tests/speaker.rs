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
fn the_airway_reads_the_live_tube_and_closes_on_a_stop() {
    let speaker = Speaker::new();
    let mut utterance = speaker.utterance(&request(r#"{"text":"mama"}"#)).unwrap();
    let mut airway = Vec::new();
    let mut lips_narrowest = f32::MAX;
    let mut lips_widest = 0f32;
    let mut velum_widest = 0f32;
    let mut chunk = [0.0; 128];
    while utterance.render(&mut chunk) > 0 {
        utterance.airway(&mut airway);
        let [ph, or, na] = [airway[3], airway[4], airway[5]].map(|n| n as usize);
        let prefix = 6 + 2 * (ph + or + na);
        let drawing = &airway[prefix..];
        assert_eq!(&drawing[..2], &[1.0, 1.0], "drawing version and presence");
        let points: usize = drawing[23..34].iter().map(|x| *x as usize).sum();
        let grid = drawing[34] as usize;
        assert_eq!(drawing.len(), 49 + 2 * points + 11 * grid);
        assert!(grid > 10 && points > 50, "real engine geometry is present");
        assert!(
            airway[1] > 0.0 && airway[2] > 0.0,
            "tube lengths are positive"
        );
        assert!(airway.iter().all(|x| x.is_finite()));
        // The last few sections of the mouth are the lips.
        let lips = airway[6 + ph + or - 3..6 + ph + or]
            .iter()
            .fold(f32::MAX, |m, x| m.min(*x));
        lips_narrowest = lips_narrowest.min(lips);
        lips_widest = lips_widest.max(lips);
        velum_widest = velum_widest.max(airway[0]);
    }
    assert!(
        lips_narrowest < 0.1,
        "the lips never close on /m/: {lips_narrowest} cm²"
    );
    assert!(
        lips_widest > 1.0,
        "the lips never open on /a/: {lips_widest} cm²"
    );
    assert!(
        velum_widest > 0.1,
        "the velum never opens on /m/: {velum_widest} cm²"
    );
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

#[test]
fn reading_geometry_never_changes_the_samples() {
    let speaker = Speaker::new();
    let json = r#"{"text":"The quick fox.","body":"female"}"#;
    let expected = render(&speaker, json, 128);
    let mut observed = speaker.utterance(&request(json)).unwrap();
    let mut audio = Vec::new();
    let mut state = Vec::new();
    let mut chunk = [0.0; 128];
    while let n @ 1.. = observed.render(&mut chunk) {
        observed.airway(&mut state);
        audio.extend_from_slice(&chunk[..n]);
    }
    assert_eq!(
        audio, expected,
        "optional geometry reads must be acoustically inert"
    );
}
