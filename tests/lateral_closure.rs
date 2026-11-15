//! A central stop must close the lateral passage opened by its preceding /l/.
use chimera::anatomy::human::{BODY_FEMALE, BODY_MALE, HumanBody};
use chimera::phonetics::Segment;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};

#[derive(Debug)]
struct Closure {
    lateral: f64,
    area: f64,
    flow: f64,
    preceding_l_peak: f64,
}

fn measure(
    after_lateral: bool,
    phone: &str,
    duration: f64,
    body: HumanBody,
    name: &str,
    f0: f64,
) -> Closure {
    let mut input = vec![Segment {
        ipa: "ɑ".into(),
        dur: Some(if after_lateral { 0.2 } else { 0.28 }),
        ..Default::default()
    }];
    if after_lateral {
        input.push(Segment {
            ipa: "l".into(),
            dur: Some(0.08),
            ..Default::default()
        });
    }
    input.extend([
        Segment {
            ipa: phone.into(),
            dur: Some(duration),
            ..Default::default()
        },
        Segment {
            ipa: "ɑ".into(),
            dur: Some(0.28),
            ..Default::default()
        },
    ]);
    let plan = plan_utterance(
        &input,
        &PlanOptions {
            body: name.into(),
            t0: 0.14,
            f0: Some(f0),
            sung: Some(true),
            ..Default::default()
        },
    );
    let d = plan
        .segments
        .iter()
        .find(|s| s.ipa == phone && s.t0 > 0.47)
        .unwrap();
    assert!((d.t0 - 0.48).abs() < 1e-9);
    let (a, b) = (d.t0 + 0.3 * duration, d.t1 - 0.125 * duration);
    let mut voice = HumanVoice::new(48000.0, body, 2);
    voice.set_source(&SourcePatch {
        f0: Some(f0),
        pressure: Some(9.0),
        tension: Some(0.55),
        voiced: Some(true),
        ..Default::default()
    });
    voice.schedule(&plan.gestures);
    let mut result = Closure {
        lateral: 0.0,
        area: 0.0,
        flow: 0.0,
        preceding_l_peak: 0.0,
    };
    let mut n = 0;
    let mut block = [0f32; 64];
    while voice.clock < b {
        voice.render(&mut block);
        if after_lateral && voice.clock >= 0.4 && voice.clock < 0.48 {
            result.preceding_l_peak = result.preceding_l_peak.max(voice.artic.x.lateral);
        }
        if voice.clock >= a && voice.clock < b {
            let (i, area) = voice
                .airway
                .or_areas
                .iter()
                .enumerate()
                .min_by(|a, b| a.1.total_cmp(b.1))
                .unwrap();
            let branch = voice.airway.oral.branch(i.min(voice.airway.oral.n - 2));
            result.lateral += voice.artic.x.lateral;
            result.area += area;
            result.flow += voice.airway.net.u[branch].abs();
            n += 1;
        }
    }
    result.lateral /= n as f64;
    result.area /= n as f64;
    result.flow /= n as f64;
    result
}

#[test]
fn an_alveolar_stop_closes_the_side_passage_after_l() {
    let plain = measure(false, "d", 0.04, BODY_MALE, "male", 220.0);
    let lateral = measure(true, "d", 0.04, BODY_MALE, "male", 220.0);
    println!("ɑdɑ: {plain:?}; ɑldɑ: {lateral:?}");
    assert!(
        lateral.lateral < 0.05,
        "the /d/ keeps an open lateral passage after /l/: {lateral:?}"
    );
    assert!(
        lateral.area < plain.area + 0.01,
        "the stop still has a geometrical side leak: {lateral:?}"
    );
    assert!(
        lateral.flow < plain.flow * 2.0 + 10.0,
        "the /l/ still bypasses the stop with oral flow: {lateral:?}"
    );
    assert!(
        lateral.preceding_l_peak > 0.7,
        "the preceding /l/ was removed instead of releasing its sides"
    );
}

#[test]
fn central_stops_nasals_and_sibilants_release_lateral_airflow() {
    for (body, name, f0) in [(BODY_MALE, "male", 220.0), (BODY_FEMALE, "female", 330.0)] {
        for phone in ["t", "n", "s", "z"] {
            let plain = measure(false, phone, 0.06, body, name, f0);
            let lateral = measure(true, phone, 0.06, body, name, f0);
            println!("{name} /l{phone}/: {lateral:?}; /ɑ{phone}/: {plain:?}");
            assert!(
                lateral.lateral < 0.05,
                "{name} /{phone}/ still opens the sides: {lateral:?}"
            );
            assert!(
                lateral.area < plain.area + 0.01 * body.scale * body.scale,
                "{name} /{phone}/ has a side leak: {lateral:?}"
            );
        }
    }
}

#[test]
fn actual_lateral_consonants_keep_their_open_passage() {
    for phone in ["l", "ɫ", "ɬ", "ɮ"] {
        let got = measure(false, phone, 0.08, BODY_MALE, "male", 220.0);
        let opening = if matches!(phone, "ɬ" | "ɮ") {
            0.35
        } else {
            1.0
        };
        println!("/{phone}/: {got:?}");
        assert!(
            got.lateral > 0.7 * opening,
            "/{phone}/ lost its side passage: {got:?}"
        );
    }
}
