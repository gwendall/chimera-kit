//! The voice's output is linear: nothing in it depends on the level. A loud sung vowel is not
//! turned down, and the consonant after it is not ducked. Gain and limiting belong to the mix (the
//! app's `AudioEngine`, the show's client routing, a song's mix); the voice keeps only a safety
//! against a diverging network, far over the loudest it sings.

use chimera::anatomy::human::{BODY_CHILD, BODY_FEMALE, BODY_MALE, BodyMix, HumanBody};
use chimera::phonetics::Segment;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::voice::human_voice::{HumanVoice, OUTPUT_SAFETY, SourcePatch};

const FS: f64 = 48000.0;
/// The highest lung pressure the lab drives a voice at (cmH2O): a crowd fan's 16 at a breath of 2.
/// The app's breath control stops at 22, the drummers' at 30. A high note's push takes the lungs
/// further, up to `PUSHED_PRESSURE_CEILING` (40).
const LOUDEST_PRESSURE: f64 = 32.0;

/// A sung plan rendered at `pressure`, its output scaled by `gain` (1: the engine's own).
fn sing(body: HumanBody, mix: BodyMix, segs: &[(&str, f64)], hz: f64, pressure: f64, gain: f64) -> (Vec<f32>, u64) {
    let segs: Vec<Segment> = segs.iter().map(|&(ipa, dur)| Segment { ipa: ipa.into(), dur: Some(dur), f0: Some(hz), ..Default::default() }).collect();
    let plan = plan_utterance(&segs, &PlanOptions { body: mix, t0: 0.1, f0: Some(hz), sung: Some(true), ..Default::default() });
    let mut v = HumanVoice::new(FS, body, 2);
    v.output_gain *= gain;
    v.set_source(&SourcePatch { f0: Some(hz), voiced: Some(true), pressure: Some(pressure), tension: Some(0.55), ..Default::default() });
    v.schedule(&plan.gestures);
    let mut out = vec![0.0f32; (FS * (plan.end + 0.2)).round() as usize];
    for chunk in out.chunks_mut(128) {
        v.render(chunk);
    }
    (out, v.safety_trips)
}

fn peak(x: &[f32]) -> f64 {
    x.iter().fold(0.0f64, |m, &s| m.max((s as f64).abs()))
}

/// [ɑsɑ] sung at 392 Hz at the app's highest breath: the output 40 dB down is the same signal
/// 40 dB down, sample for sample. With the old output limiter (a held peak envelope at 0.75) the
/// loud render was turned down by up to 17 dB and the /s/ after each loud vowel ducked with it.
#[test]
fn a_loud_vowel_and_the_consonant_after_it_scale_with_the_output_gain() {
    let segs = [("ɑ", 0.4), ("s", 0.12), ("ɑ", 0.4)];
    let (loud, trips) = sing(BODY_MALE, BodyMix::MALE, &segs, 392.0, 22.0, 1.0);
    let (soft, _) = sing(BODY_MALE, BodyMix::MALE, &segs, 392.0, 22.0, 0.01);
    let top = peak(&loud);
    assert!(top > 1.5, "the case must be loud (peak {top:.2}), where the old limiter turned it down");
    assert_eq!(trips, 0);
    let worst = loud.iter().zip(&soft).fold(0.0f64, |m, (&a, &b)| m.max((a as f64 - 100.0 * b as f64).abs()));
    assert!(worst <= 1e-5 * top, "the output is not linear: {worst:.2e} off at peak {top:.2}");
}

/// Every body's upper range in semitones, [a] and [ɑ] (the loudest vowels), at the highest lung
/// pressure: the safety never trips, with a wide margin.
#[test]
fn the_loudest_voice_stays_far_under_the_safety() {
    let bodies = [(BODY_MALE, BodyMix::MALE, 196.0, 466.0), (BODY_FEMALE, BodyMix::FEMALE, 440.0, 1047.0), (BODY_CHILD, BodyMix::CHILD, 523.0, 1175.0)];
    let mut top = (0.0, "", "", 0.0);
    for (body, mix, lo, hi) in bodies {
        let mut hz = lo;
        while hz <= hi {
            for vowel in ["a", "ɑ"] {
                let (out, trips) = sing(body, mix, &[(vowel, 0.6)], hz, LOUDEST_PRESSURE, 1.0);
                assert_eq!(trips, 0, "{} [{vowel}] at {hz:.0} Hz tripped the safety", body.name);
                let p = peak(&out);
                if p > top.0 {
                    top = (p, body.name, vowel, hz);
                }
            }
            hz *= 2f64.powf(1.0 / 12.0);
        }
    }
    let (p, name, vowel, hz) = top;
    eprintln!("loudest: {name} [{vowel}] at {hz:.0} Hz, {LOUDEST_PRESSURE} cmH2O, peak {p:.2} ({:.1} dB under the safety)", 20.0 * (OUTPUT_SAFETY / p).log10());
    assert!(p < OUTPUT_SAFETY / 4.0, "{name} [{vowel}] at {hz:.0} Hz peaks {p:.2}, within 12 dB of the safety ({OUTPUT_SAFETY})");
}
