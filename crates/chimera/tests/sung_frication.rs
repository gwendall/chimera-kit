//! A sung /s/ keeps its level against its vowel up the range (Billie Jean, 2026-11-14): the
//! glottis grew 11 dB an octave at a fixed lung pressure while frication follows only the
//! pressure, and the output limiter the voice had then, turning the loud vowel down, turned the
//! /s/ after it down too, so at 330 Hz a sung /s/ sat 14 dB further under its vowel than at 110 Hz and the legato
//! audit heard 30 fricatives as cuts. Real singers raise their lung pressure with the pitch
//! (Titze & Sundberg 1992) and their sibilants keep pace with their vowels. The higher pressure
//! must not open what the voice holds shut (a glottal stop keeps its seal) nor outlast the
//! breath (a rest after a high note stays quiet).
use chimera::anatomy::human::{BODY_MALE, BodyMix};
use chimera::phonetics::english::EnglishG2P;
use chimera::math::hz_to_midi;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::phonetics::Segment;
use chimera::phonetics::sing::{SongOptions, SungNote, plan_song};
use chimera::phonetics::syllables::lyrics_to_syllables;
use chimera::control::score::{ControlKey, Gesture, Targets};
use chimera::sources::glottis::PUSHED_PRESSURE_CEILING;
use chimera::voice::human_voice::{HumanVoice, SourcePatch, VoiceTelemetry};

const FS: f64 = 48000.0;

fn rms_db(x: &[f32], a: f64, b: f64) -> f64 {
    let s = &x[(a * FS) as usize..(b * FS) as usize];
    10.0 * (s.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / s.len() as f64 + 1e-20).log10()
}

/// /s/ level under the vowel before it (dB), "sah sah" sung at `hz` as the CSD judge sings.
fn s_to_vowel(hz: f64) -> f64 {
    let mut g = EnglishG2P::new();
    g.load_dict("sah\tS AA1\n");
    let notes: Vec<SungNote> = lyrics_to_syllables("sah sah", &g).into_iter().map(|syl| SungNote { midi: hz_to_midi(hz), beats: 1.0, syl }).collect();
    let plan = plan_song(&notes, &SongOptions { body: "male".into(), bpm: 90.0, t0: 0.5, vibrato: 0.0 });
    let mut v = HumanVoice::new(FS, BODY_MALE, 2);
    v.set_source(&SourcePatch { f0: Some(hz), voiced: Some(true), pressure: Some(9.0), tension: Some(0.55), ..Default::default() });
    v.schedule(&plan.gestures);
    let mut out = vec![0.0f32; (FS * (plan.end + 0.3)).round() as usize];
    for chunk in out.chunks_mut(128) {
        v.render(chunk);
    }
    let seg = &plan.segments;
    let k = seg.iter().rposition(|s| s.ipa == "s").unwrap();
    let (vw, s) = (&seg[k - 1], &seg[k]);
    let d = vw.t1 - vw.t0;
    rms_db(&out, s.t0 + 0.02, s.t1 - 0.01) - rms_db(&out, vw.t0 + 0.2 * d, vw.t1 - 0.2 * d)
}

/// -8.2 dB at 110 Hz and -25.3 at 330 Hz at the speaking pressure (17.1 dB apart); -5.5 and
/// -18.8 with the pressure following the threshold and the jet noise free of its Reynolds ceiling
/// (13.3 apart). The pressure alone did nothing for the /s/: the ceiling bound at the Re (14000 to
/// 15000) it gave the /s/. With the output limiter the voice had then, which turned the loud vowel
/// down, -22.3 and -14.6.
#[test]
fn a_sung_s_keeps_pace_with_its_vowel_up_the_range() {
    let low = s_to_vowel(110.0);
    let high = s_to_vowel(330.0);
    eprintln!("sung /s/ under its vowel: {low:.1} dB at 110 Hz, {high:.1} dB at 330 Hz");
    assert!(high - low > -15.0, "an /s/ sung at 330 Hz is {:.1} dB further under its vowel than at 110 Hz", low - high);
}

/// The quietest 5 ms inside the ʔ of a sung "ʌ ʔ h ʌ" at `hz`, under the vowel before it (dB).
fn glottal_stop_floor(hz: f64) -> f64 {
    let segs: Vec<Segment> = [("ʌ", 0.3), ("ʔ", 0.06), ("h", 0.05), ("ʌ", 0.3)]
        .iter()
        .map(|&(ipa, d)| Segment { ipa: ipa.into(), dur: Some(d), f0: Some(hz), ..Default::default() })
        .collect();
    let plan = plan_utterance(&segs, &PlanOptions { body: BodyMix::MALE, t0: 0.14, f0: Some(hz), sung: Some(true), ..Default::default() });
    let mut v = HumanVoice::new(FS, BODY_MALE, 2);
    v.set_source(&SourcePatch { f0: Some(hz), voiced: Some(true), pressure: Some(9.0), tension: Some(0.55), ..Default::default() });
    v.schedule(&plan.gestures);
    let mut out = vec![0.0f32; (FS * (plan.end + 0.3)).round() as usize];
    for chunk in out.chunks_mut(128) {
        v.render(chunk);
    }
    let (vw, q) = (&plan.segments[0], &plan.segments[1]);
    let d = vw.t1 - vw.t0;
    let floor = (0..)
        .map(|i| q.t0 + 0.001 * i as f64)
        .take_while(|t| t + 0.005 <= q.t1)
        .map(|t| rms_db(&out, t, t + 0.005))
        .fold(f64::INFINITY, f64::min);
    floor - rms_db(&out, vw.t0 + 0.2 * d, vw.t1 - 0.2 * d)
}

/// The hiccup of Billie Jean's lead (ʔ ʌ ʔ h at 482 to 545 Hz, validated by the founder) leaked
/// through its second ʔ, the one before the /h/, once the lungs pushed harder for its pitch: the
/// fold closure shut 92 % of the /h/'s opening whatever the pressure, the floor came up from -70
/// to -49 dB and the attack after it slowed from 14 to 38 ms. A voice that pushes harder presses
/// its folds harder, so a sung ʔ before /h/ stays about as deep at the top of the chest range as
/// with the speaking pressure: its floor at 330 and 345 Hz is -59.8 and -57.9 dB under its vowel
/// (-55.1 at 330 Hz with the speaking pressure; -43.0 and -39.6 with the fixed seal, measured
/// before the pressure went with the breath and the jet noise lost its Reynolds ceiling).
#[test]
fn a_sung_glottal_stop_before_h_keeps_its_seal_up_the_chest_range() {
    let floors: Vec<(f64, f64)> = [330.0, 345.0].iter().map(|&hz| (hz, glottal_stop_floor(hz))).collect();
    for &(hz, floor) in &floors {
        eprintln!("sung ʔ before /h/ at {hz} Hz: floor {floor:.1} dB under its vowel");
    }
    for &(hz, floor) in &floors {
        assert!(floor < -47.0, "a ʔ sung before /h/ at {hz} Hz leaks: its floor is {floor:.1} dB under its vowel");
    }
}

/// 6-12 kHz energy (dB) of `x` in `a..b`: two RBJ high-pass biquads at 6 kHz (the band a breath's
/// [h] fills and a voice's harmonics barely reach).
fn hiss_db(x: &[f32], a: f64, b: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * 6000.0 / FS;
    let (cw, al) = (w.cos(), w.sin() / (2.0 * 0.7071));
    let (b0, b1, a0, a1, a2) = ((1.0 + cw) / 2.0, -(1.0 + cw), 1.0 + al, -2.0 * cw, 1.0 - al);
    let mut y: Vec<f64> = x.iter().map(|&v| v as f64).collect();
    for _ in 0..2 {
        let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
        for v in y.iter_mut() {
            let x0 = *v;
            let y0 = (b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0;
            (x2, x1, y2, y1) = (x1, x0, y1, y0);
            *v = y0;
        }
    }
    let s = &y[(a * FS) as usize..(b * FS) as usize];
    10.0 * (s.iter().map(|v| v * v).sum::<f64>() / s.len() as f64 + 1e-30).log10()
}

/// A sung ɑ ending a phrase at `hz`: the hiss 60 to 80 ms after its end, under the vowel (dB).
fn release_hiss(hz: f64) -> f64 {
    let segs = vec![Segment { ipa: "ɑ".into(), dur: Some(0.6), f0: Some(hz), ..Default::default() }];
    let plan = plan_utterance(&segs, &PlanOptions { body: BodyMix::MALE, t0: 0.2, f0: Some(hz), sung: Some(true), ..Default::default() });
    let mut v = HumanVoice::new(FS, BODY_MALE, 2);
    v.set_source(&SourcePatch { f0: Some(hz), voiced: Some(true), pressure: Some(9.0), tension: Some(0.55), ..Default::default() });
    v.schedule(&plan.gestures);
    let mut out = vec![0.0f32; (FS * (plan.end + 0.3)).round() as usize];
    for chunk in out.chunks_mut(128) {
        v.render(chunk);
    }
    let vw = &plan.segments[0];
    let d = vw.t1 - vw.t0;
    hiss_db(&out, vw.t1 + 0.06, vw.t1 + 0.08) - rms_db(&out, vw.t0 + 0.2 * d, vw.t1 - 0.2 * d)
}

/// The lungs push harder for a high note, but only for the vibrating folds: held to the end of
/// the breath, that push left the parting folds after every high note breathing at the note's
/// pressure, a hiss -50.6 and -52.4 dB under the vowel at 220 and 330 Hz, heard as breathy rests
/// (Billie Jean, 2026-11-14). Going with the breath, -60.4 and -66.2 dB.
#[test]
fn a_rest_after_a_high_note_does_not_breathe_at_its_pressure() {
    for hz in [220.0, 330.0] {
        let hiss = release_hiss(hz);
        eprintln!("hiss 60-80 ms after a phrase sung at {hz} Hz: {hiss:.1} dB under its vowel");
        assert!(hiss < -56.0, "the folds parting after a phrase sung at {hz} Hz hiss {hiss:.1} dB under its vowel");
    }
}

/// A sung ɑ at `hz` whose breath falls to `breath` over its middle, as a melisma's carried note
/// does: the lung pressure applied at the dip over the one applied at the full breath before it.
fn pressure_kept_at_lowered_breath(hz: f64, breath: f64) -> f64 {
    let segs = vec![Segment { ipa: "ɑ".into(), dur: Some(0.9), f0: Some(hz), ..Default::default() }];
    let plan = plan_utterance(&segs, &PlanOptions { body: BodyMix::MALE, t0: 0.2, f0: Some(hz), sung: Some(true), ..Default::default() });
    let vw = &plan.segments[0];
    let (before, dip) = (vw.t0 + 0.2, 0.5 * (vw.t0 + vw.t1));
    let mut gestures = plan.gestures.clone();
    gestures.push(Gesture::new(dip - 0.1, dip + 0.1, 0.02, 0.02, 100.0, Targets::default().with(ControlKey::BREATH, breath)).label("carried"));
    let mut v = HumanVoice::new(FS, BODY_MALE, 2);
    v.set_source(&SourcePatch { f0: Some(hz), voiced: Some(true), pressure: Some(9.0), tension: Some(0.55), ..Default::default() });
    v.schedule(&gestures);
    let mut tel = VoiceTelemetry::default();
    let (mut p_before, mut p_dip) = (f64::NAN, f64::NAN);
    let mut out = [0.0f32; 128];
    for k in 0..((dip + 0.05) * FS / 128.0) as usize {
        v.render(&mut out);
        let t = (k + 1) as f64 * 128.0 / FS;
        if (t - before).abs() < 64.0 / FS || (t - dip).abs() < 64.0 / FS {
            v.telemetry(&mut tel);
            if t < dip - 0.05 { p_before = tel.p_lung } else { p_dip = tel.p_lung }
        }
    }
    p_dip / p_before
}

/// A high note's push is the phrase's: a lowered breath turns a sung note's pressure down in the
/// same proportion at any pitch. Scaled by the breath a second time, the push left a melisma's
/// carried notes at 294 Hz dipping up to 2.1 dB deeper than their source (test_gimmicks); here
/// 0.39 of the pressure at 220 Hz against 0.51 at 110 Hz.
#[test]
fn a_lowered_breath_keeps_its_high_notes_push() {
    let spoken = pressure_kept_at_lowered_breath(110.0, 0.5);
    for hz in [220.0, 330.0, 440.0] {
        let sung = pressure_kept_at_lowered_breath(hz, 0.5);
        eprintln!("breath 0.5 at {hz} Hz keeps {sung:.3} of the pressure (110 Hz: {spoken:.3})");
        assert!((sung / spoken - 1.0).abs() < 0.02, "breath 0.5 at {hz} Hz keeps {sung:.3} of the pressure, {spoken:.3} at 110 Hz");
    }
}

/// The lung pressure applied, block by block, through a crowd's scream: a man's "ah" at 13 cmH2O
/// and a breath of 1.8 (as the concert's fans scream), rising a semitone at a time from 150 Hz to
/// 365 Hz, the top of his chest voice (it changes to thin folds a semitone over the passaggio).
fn scream_lung_pressure() -> Vec<f64> {
    let (lo, steps) = (150.0f64, 16);
    let segs: Vec<Segment> = (0..steps)
        .map(|k| Segment { ipa: "ɑ".into(), dur: Some(0.07), f0: Some(lo * 2f64.powf(k as f64 / 12.0)), ..Default::default() })
        .collect();
    let plan = plan_utterance(&segs, &PlanOptions { body: BodyMix::MALE, t0: 0.2, f0: Some(lo), sung: Some(true), ..Default::default() });
    let mut gestures = plan.gestures.clone();
    gestures.push(Gesture::new(0.0, plan.end, 0.05, 0.05, 100.0, Targets::default().with(ControlKey::BREATH, 1.8)).label("scream"));
    let mut v = HumanVoice::new(FS, BODY_MALE, 2);
    v.set_source(&SourcePatch { f0: Some(lo), voiced: Some(true), pressure: Some(13.0), tension: Some(0.55), ..Default::default() });
    v.schedule(&gestures);
    let mut tel = VoiceTelemetry::default();
    let mut out = [0.0f32; 128];
    (0..(plan.segments[steps - 1].t1 * FS / 128.0) as usize)
        .map(|_| {
            v.render(&mut out);
            v.telemetry(&mut tel);
            tel.p_lung
        })
        .collect()
}

/// The push multiplied the source's pressure by the threshold's rise with no ceiling: a crowd's
/// scream asked up to 88 cmH2O of the lungs, and 32 cmH2O on a chest note at 370 Hz asked 131 and
/// peaked 8.6 dB over the voice without the push (linear_output). The push stops at the pressure
/// singers reach, smoothly: the step it takes from block to block where it meets the ceiling is no
/// larger than those it took climbing to it.
#[test]
fn a_high_scream_stays_under_the_lung_pressure_ceiling() {
    let p = scream_lung_pressure();
    let top = p.iter().cloned().fold(0.0, f64::max);
    let reach = p.iter().position(|&x| x >= PUSHED_PRESSURE_CEILING - 0.01).expect("the scream must rise into the ceiling");
    let step = |a: usize, b: usize| (a.max(1)..b).map(|i| (p[i] - p[i - 1]).abs()).fold(0.0, f64::max);
    let (climb, meet) = (step(reach.saturating_sub(40), reach), step(reach.saturating_sub(4), (reach + 8).min(p.len())));
    eprintln!("scream: lungs up to {top:.2} cmH2O, ceiling met {:.0} ms in, largest step {meet:.3} there, {climb:.3} climbing", reach as f64 * 128.0 / FS * 1000.0);
    assert!(top <= PUSHED_PRESSURE_CEILING + 1e-6, "a scream's lungs reached {top:.2} cmH2O, over the {PUSHED_PRESSURE_CEILING} singers reach");
    assert!(meet <= climb + 1e-9, "the push jumped {meet:.3} cmH2O in a block meeting the ceiling, against {climb:.3} climbing to it");
}
