//! A sung voiced closure keeps its voice bar. Between two /a/ (0.6 s each, the consonant 60 ms,
//! the pitch held at 220 or 440 Hz, pressure 9, tension 0.55, as `chimera render aligned` sings
//! them), /b d g ɾ/ fell 33 to 71 dB under the vowel and /dʒ/ 23 to 26 dB: the voice stopped 6
//! to 42 ms into the closure as the sealed airway filled with the glottal flow, where a voiced
//! closure keeps its voice (in TSP speech it sits 17 to 40 dB under the vowel, by consonant and
//! speaker). The planner now makes room behind the closure (`voice_bar` in planner.rs) and gives
//! the tap one short contact. /m z v/ never lost their voice and must not change.
//!
//! After a higher vowel that room was not enough: the closure came early and long, and /d/
//! fell 60 to 92 dB after /i e/, /ɾ/ 61 to 70 dB and /g/ 27 to 36 dB after /i/, /b/ stopped
//! voicing after /u/. The room now grows with the vowel's height.
//!
//! The depths are against the vowel as the voice sings it. Until the voice's output became linear
//! they were against a vowel its output limiter had turned down (/a/ at both pitches, /e o/ at
//! 440 Hz), while the limiter's release lifted the closure after it: those closures read 1.5 to
//! 5 dB shallower (a-b-a at 440 Hz 32.0 dB under the vowel, now 36.9; e-g-e 33.6, now 38.3). The
//! others did not move. At 440 Hz the voice bar after /a e/ is thus 36 to 38 dB under the vowel.
//! That is the sealed tract, not a fault: closed, it resonates near 150 to 200 Hz (Fant 1972) and
//! passes little above; in TSP speech (anechoic, the same /b d g/ between vowels) a woman's
//! closure passes her harmonics near 450 Hz 34 to 38 dB under the vowel's (the engine 30 to 37),
//! and at speech pitch the engine's closures are 3 to 8 dB shallower than the speakers'. A
//! singer's dips between notes (CSD) stop at 22 to 32 dB at every pitch, as deep as her voiceless
//! /p k/ (30, 34): short or open closures, not a louder voice bar. The bound only catches a
//! closure that falls silent.
use chimera::anatomy::human::BODY_MALE;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::phonetics::{Intonation, Segment};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};

const FS: f64 = 48000.0;
/// A closure deeper than this under the vowel has fallen silent (the deepest kept is e-g-e at
/// 440 Hz, 38.3 dB; the voice stopping fell 60 to 92). It is not a depth to reach: a voiced
/// closure in TSP speech sits 17 to 40 dB under the vowel.
const SILENT_DB: f64 = -40.0;

#[derive(Debug)]
struct Sung {
    /// the lowest 10 ms level from 0.66 to 0.86 s, against the vowel's (dB)
    min_db: f64,
    /// ms with the oral tract sealed (narrowest section under 0.001 cm²)
    sealed_ms: usize,
    /// ms with the narrowest section under 0.05 cm² (the tongue on the ridge)
    contact_ms: usize,
    /// sealed ms in which the glottis no longer voices
    unvoiced_sealed_ms: usize,
    voice_bar: bool,
}

fn sing(v: &str, c: &str, f0: f64) -> Sung {
    let seg = |ipa: &str, dur: f64| Segment {
        ipa: ipa.into(),
        dur: Some(dur),
        f0: Some(f0),
        ..Default::default()
    };
    let plan = plan_utterance(
        &[seg(v, 0.6), seg(c, 0.06), seg(v, 0.6)],
        &PlanOptions {
            body: "male".into(),
            t0: 0.04,
            f0: Some(f0),
            intonation: Some(Intonation::Flat),
            sung: Some(true),
            ..Default::default()
        },
    );
    let s = plan.segments.iter().find(|s| s.ipa == c).unwrap();
    assert!(
        (s.t0 - 0.7).abs() < 1e-9 && (s.t1 - 0.76).abs() < 1e-9,
        "{c} at {}..{}",
        s.t0,
        s.t1
    );
    let voice_bar = plan.gestures.iter().any(|g| g.label_str() == "voice bar");
    let mut voice = HumanVoice::new(FS, BODY_MALE, 2);
    voice.set_source(&SourcePatch {
        f0: Some(f0),
        pressure: Some(9.0),
        tension: Some(0.55),
        voiced: Some(true),
        ..Default::default()
    });
    voice.schedule(&plan.gestures);
    let oral = voice.airway.oral;
    let mut out = vec![0f32; FS as usize];
    let (mut sealed_ms, mut contact_ms, mut unvoiced_sealed_ms) = (0, 0, 0);
    for (k, block) in out.chunks_mut(48).enumerate() {
        voice.render(block);
        let t = (k + 1) as f64 / 1000.0;
        if t > 0.6 && t < 0.9 {
            let net = &voice.airway.net;
            let narrowest = (oral.first..oral.first + oral.n)
                .map(|j| net.amin[j].min(net.area[j]))
                .fold(f64::INFINITY, f64::min);
            contact_ms += usize::from(narrowest < 0.05);
            if narrowest < 1e-3 {
                sealed_ms += 1;
                unvoiced_sealed_ms += usize::from(voice.glottis.voicing < 0.5);
            }
        }
    }
    // 10 ms RMS every ms, against the vowel's mean power from 0.45 to 0.65 s
    let (w, hop) = (480, 48);
    let level = |i: usize| {
        out[i..i + w]
            .iter()
            .map(|&x| f64::from(x).powi(2))
            .sum::<f64>()
            / w as f64
    };
    let centre = |i: usize| (i + w / 2) as f64 / FS;
    let starts = (0..out.len() - w).step_by(hop);
    let vowel: Vec<f64> = starts
        .clone()
        .filter(|&i| centre(i) > 0.45 && centre(i) < 0.65)
        .map(level)
        .collect();
    let vowel = vowel.iter().sum::<f64>() / vowel.len() as f64;
    let min = starts
        .filter(|&i| centre(i) > 0.66 && centre(i) < 0.86)
        .map(level)
        .fold(f64::INFINITY, f64::min);
    Sung {
        min_db: 10.0 * ((min + 1e-20) / vowel).log10(),
        sealed_ms,
        contact_ms,
        unvoiced_sealed_ms,
        voice_bar,
    }
}

#[test]
fn a_sung_voiced_closure_keeps_its_voice_bar() {
    for f0 in [220.0, 440.0] {
        for c in ["b", "d", "g", "ɾ", "dʒ"] {
            let s = sing("a", c, f0);
            println!("a{c}a {f0} Hz: {s:?}");
            assert!(
                s.voice_bar,
                "a{c}a {f0} Hz: no room is made for the voice: {s:?}"
            );
            assert!(
                s.min_db >= SILENT_DB,
                "a{c}a {f0} Hz: the closure falls silent: {s:?}"
            );
            assert_eq!(
                s.unvoiced_sealed_ms, 0,
                "a{c}a {f0} Hz: the voice stops during the closure: {s:?}"
            );
            match c {
                // still a stop: the tract seals
                "b" | "d" | "g" => assert!(s.sealed_ms >= 15, "a{c}a {f0} Hz: no closure: {s:?}"),
                // a tap touches briefly
                "ɾ" => assert!(
                    s.contact_ms >= 10 && s.sealed_ms < 15,
                    "a{c}a {f0} Hz: not a tap: {s:?}"
                ),
                _ => {}
            }
        }
    }
}

#[test]
fn voiced_continuants_are_unchanged() {
    for f0 in [220.0, 440.0] {
        for c in ["m", "z", "v"] {
            let s = sing("a", c, f0);
            println!("a{c}a {f0} Hz: {s:?}");
            assert!(!s.voice_bar, "a{c}a {f0} Hz: {s:?}");
            assert!(s.min_db >= -20.0, "a{c}a {f0} Hz: {s:?}");
        }
    }
}

#[test]
fn a_voiced_closure_after_a_higher_vowel_keeps_its_voice_bar() {
    for v in ["i", "u", "e", "o"] {
        for f0 in [220.0, 440.0] {
            for c in ["b", "d", "g", "ɾ", "dʒ"] {
                let s = sing(v, c, f0);
                println!("{v}{c}{v} {f0} Hz: {s:?}");
                assert!(
                    s.min_db >= SILENT_DB,
                    "{v}{c}{v} {f0} Hz: the closure falls silent: {s:?}"
                );
                assert_eq!(
                    s.unvoiced_sealed_ms, 0,
                    "{v}{c}{v} {f0} Hz: the voice stops during the closure: {s:?}"
                );
                if matches!(c, "b" | "d" | "g") {
                    assert!(s.sealed_ms >= 15, "{v}{c}{v} {f0} Hz: no closure: {s:?}");
                }
            }
        }
    }
}
