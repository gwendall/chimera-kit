//! The voice space: bodies around and between the three calibrated ones.

use intone_chimera::{Body, Request, ScoreRequest, Speaker};

fn request(json: &str) -> Request {
    serde_json::from_str(json).unwrap()
}

fn render(speaker: &Speaker, json: &str) -> Vec<f32> {
    let mut utterance = speaker.utterance(&request(json)).unwrap();
    let mut out = vec![0.0; utterance.total_samples()];
    let mut at = 0;
    while at < out.len() {
        at += utterance.render(&mut out[at..]);
    }
    out
}

#[test]
fn a_spec_that_changes_nothing_is_its_preset_bit_for_bit() {
    let speaker = Speaker::new();
    let text = r#""text":"The birch canoe slid on the smooth planks.""#;
    for (named, spec) in [
        (r#""male""#, r#"{}"#),
        (r#""female""#, r#"{"female":1}"#),
        (r#""child""#, r#"{"female":0,"child":1}"#),
    ] {
        let a = render(&speaker, &format!("{{{text},\"body\":{named}}}"));
        let b = render(&speaker, &format!("{{{text},\"body\":{spec}}}"));
        assert!(a == b, "{named} and {spec} differ");
    }
}

#[test]
fn every_dimension_changes_the_sound() {
    let speaker = Speaker::new();
    let base = render(&speaker, r#"{"text":"Hello there.","body":{"female":0.5}}"#);
    for field in [
        r#""size":1.1"#,
        r#""throat":1.1"#,
        r#""tongue":1.1"#,
        r#""lips":1.1"#,
        r#""pitch":2"#,
        r#""breathiness":0.5"#,
        r#""tension":0.8"#,
        r#""brightness":0.6"#,
        r#""fry":0.5"#,
        r#""roughness":0.5"#,
    ] {
        let other = render(
            &speaker,
            &format!(r#"{{"text":"Hello there.","body":{{"female":0.5,{field}}}}}"#),
        );
        assert!(other != base, "{field} changed nothing");
        assert!(
            other.iter().all(|x| x.is_finite() && x.abs() <= 1.0),
            "{field}: out of range"
        );
    }
}

/// The pharynx's and the mouth's lengths (cm) a moment into "Ah", from the airway itself.
fn lengths(speaker: &Speaker, body: &str) -> (f32, f32) {
    let mut utterance = speaker
        .utterance(&request(&format!(r#"{{"text":"Ah.","body":{body}}}"#)))
        .unwrap();
    let mut out = vec![0.0; 4800];
    utterance.render(&mut out);
    let mut airway = Vec::new();
    utterance.airway(&mut airway);
    (airway[1], airway[2])
}

#[test]
fn size_scales_the_whole_airway_and_throat_the_pharynx_alone() {
    let speaker = Speaker::new();
    let (pharynx, mouth) = lengths(&speaker, "{}");
    let (big_pharynx, big_mouth) = lengths(&speaker, r#"{"size":1.2}"#);
    assert!(
        (big_pharynx / pharynx - 1.2).abs() < 0.03,
        "{big_pharynx} vs {pharynx}"
    );
    assert!(
        (big_mouth / mouth - 1.2).abs() < 0.03,
        "{big_mouth} vs {mouth}"
    );
    let (long_pharynx, same_mouth) = lengths(&speaker, r#"{"throat":1.2}"#);
    assert!(long_pharynx > pharynx * 1.1, "{long_pharynx} vs {pharynx}");
    assert!(
        (same_mouth / mouth - 1.0).abs() < 0.03,
        "{same_mouth} vs {mouth}"
    );
}

/// RMS level in dB.
fn level_db(samples: &[f32]) -> f64 {
    let sum: f64 = samples.iter().map(|x| f64::from(*x).powi(2)).sum();
    10.0 * (sum / samples.len() as f64).log10()
}

/// Without the correction, size 0.9 came out 7.4 dB below size 1 and 1.1 1.5 dB above: seeded
/// voices in one chat sat 11 dB apart. `Body::level` copies the engine's gain ramp, so this also
/// catches the copy drifting from the engine.
#[test]
fn size_leaves_the_level_alone() {
    let speaker = Speaker::new();
    let mut report = Vec::new();
    for blend in ["", r#""female":1,"#, r#""female":0.5,"child":0.3,"#] {
        let at = |size: f64| {
            level_db(&render(
                &speaker,
                &format!(
                    r#"{{"text":"The birch canoe slid on the smooth planks.","body":{{{blend}"size":{size}}}}}"#
                ),
            ))
        };
        let reference = at(1.0);
        let changes: Vec<(f64, f64)> = [0.8, 0.9, 0.95, 1.05, 1.1, 1.2]
            .iter()
            .map(|&size| (size, at(size) - reference))
            .collect();
        if changes.iter().any(|(_, change)| change.abs() >= 1.5) {
            report.push(format!("{{{blend}}} {changes:.2?}"));
        }
    }
    assert!(report.is_empty(), "level change by size (dB): {report:#?}");
}

#[test]
fn pitch_moves_the_default_f0_and_a_requested_f0_wins() {
    let speaker = Speaker::new();
    let plan = |body: &str| {
        speaker
            .plan(&request(&format!(r#"{{"text":"Hello.","body":{body}}}"#)))
            .unwrap()
    };
    let first = |s: &intone_chimera::score::Score| s.pitch[0][1];
    let octave_up = first(&plan(r#"{"pitch":12}"#)) / first(&plan(r#""male""#));
    assert!((octave_up - 2.0).abs() < 1e-9, "{octave_up}");
    let pinned = speaker
        .plan(&request(
            r#"{"text":"Hello.","f0":150,"body":{"pitch":12}}"#,
        ))
        .unwrap();
    assert_eq!(first(&pinned), 150.0);
}

#[test]
fn a_planned_score_states_the_bodys_tension_and_a_scores_own_wins() {
    let speaker = Speaker::new();
    let score = speaker
        .plan(&request(r#"{"text":"Hello.","body":{"tension":0.7}}"#))
        .unwrap();
    assert_eq!(score.tension, Some(vec![[0.0, 0.7]]));
    // The score path renders with the body's anatomy and source.
    let render_score = |body: &str, tension: f64| {
        let mut score = score.clone();
        score.tension = Some(vec![[0.0, tension]]);
        let req: ScoreRequest = serde_json::from_value(serde_json::json!({
            "score": score,
            "body": serde_json::from_str::<serde_json::Value>(body).unwrap(),
        }))
        .unwrap();
        let mut u = speaker.utterance_from_score(&req).unwrap();
        let mut out = vec![0.0; u.total_samples()];
        let mut at = 0;
        while at < out.len() {
            at += u.render(&mut out[at..]);
        }
        out
    };
    assert!(
        render_score(r#"{"tension":0.7}"#, 0.7) == render_score(r#"{"tension":0.2}"#, 0.7),
        "the score's tension wins over the body's"
    );
    assert!(
        render_score(r#"{"size":1.1}"#, 0.5) != render_score(r#"{}"#, 0.5),
        "the score path builds the body's airway"
    );
}

#[test]
fn bad_bodies_are_refused_by_name() {
    let speaker = Speaker::new();
    let error = |body: &str| -> String {
        let parsed = serde_json::from_str::<Request>(&format!(r#"{{"text":"Hi.","body":{body}}}"#));
        match parsed {
            Err(e) => e.to_string(),
            Ok(req) => speaker.utterance(&req).err().expect("refused"),
        }
    };
    assert!(error(r#"{"sise":1.1}"#).contains("sise"));
    assert!(error(r#""femal""#).contains("femal"));
    assert!(error(r#"{"size":2}"#).contains("body.size"));
    assert!(error(r#"{"pitch":-30}"#).contains("body.pitch"));
    assert!(error(r#"{"breathiness":1.5}"#).contains("body.breathiness"));
    assert!(error(r#"{"female":2}"#).contains("body.female"));
}

#[test]
fn a_blend_alone_is_a_blend() {
    let blend: Body = serde_json::from_str(r#"{"female":0.3,"child":0.2}"#).unwrap();
    assert_eq!(blend.mix().female, 0.3);
    let named: Body = serde_json::from_str(r#""child""#).unwrap();
    assert_eq!(named.mix().child, 1.0);
}
