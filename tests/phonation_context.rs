//! Phonation planned from a segment's neighbours: an /h/ between voiced sounds is breathy-voiced
//! unless written [h̥], and a voiceless stop before a voiced consonant of the next syllable is
//! unreleased into it.
use chimera::anatomy::human::{BODY_MALE, BodyMix};
use chimera::control::score::ControlKey;
use chimera::phonetics::ipa::tokenize_ipa;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::phonetics::{Plan, Segment};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};

const FS: f64 = 48000.0;

/// A segment; a trailing `#` marks the end of a word ("t#").
fn seg(ipa: &str, dur: f64, f0: f64) -> Segment {
    let (ipa, word_end) = ipa.strip_suffix('#').map_or((ipa, None), |s| (s, Some(true)));
    Segment { ipa: ipa.into(), dur: Some(dur), f0: Some(f0), word_end, ..Default::default() }
}

/// A sung plan of `ipa:duration` segments at a constant pitch, its first segment at 0.2 s.
fn sung(seq: &[(&str, f64)], f0: f64) -> Plan {
    let segs: Vec<Segment> = seq.iter().map(|&(ipa, d)| seg(ipa, d, f0)).collect();
    plan_utterance(&segs, &PlanOptions { body: BodyMix::MALE, t0: 0.14, f0: Some(f0), sung: Some(true), ..Default::default() })
}

/// The labels and values of a plan's abduction gestures.
fn abductions(plan: &Plan) -> Vec<(String, f64)> {
    plan.gestures.iter().filter_map(|g| g.targets.get(ControlKey::ABDUCTION).map(|v| (g.label_str().to_string(), v))).filter(|(l, _)| l != "exhale").collect()
}

/// The male voice singing a plan (pressure 9, tension 0.55): the samples, and the glottis'
/// voicing gate at the end of each 64-sample block.
fn render(plan: &Plan, f0: f64, secs: f64) -> (Vec<f32>, Vec<f64>) {
    let mut v = HumanVoice::new(FS, BODY_MALE, 2);
    v.set_source(&SourcePatch { f0: Some(f0), pressure: Some(9.0), tension: Some(0.55), voiced: Some(true), ..Default::default() });
    v.schedule(&plan.gestures);
    let mut out = vec![0f32; (secs * FS) as usize];
    let mut gate = Vec::with_capacity(out.len() / 64 + 1);
    for block in out.chunks_mut(64) {
        v.render(block);
        gate.push(v.glottis.voicing);
    }
    (out, gate)
}

fn db(x: &[f32], a: f64, b: f64) -> f64 {
    let w = &x[(a * FS).round() as usize..(b * FS).round() as usize];
    10.0 * (w.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / w.len() as f64 + 1e-20).log10()
}

/// The quietest 10 ms of `a..b` (every 1 ms).
fn floor(x: &[f32], a: f64, b: f64) -> f64 {
    (0..((b - a - 0.01) * 1000.0).round() as usize + 1).map(|i| db(x, a + i as f64 * 0.001, a + i as f64 * 0.001 + 0.01)).fold(f64::INFINITY, f64::min)
}

/// The lowest voicing gate over the blocks ending in `a..b`.
fn lowest_gate(gate: &[f64], a: f64, b: f64) -> f64 {
    gate.iter().enumerate().filter(|(k, _)| (a..b).contains(&((k + 1) as f64 * 64.0 / FS))).map(|(_, g)| *g).fold(f64::INFINITY, f64::min)
}

#[test]
fn an_h_between_voiced_sounds_is_planned_breathy_voiced() {
    let planned_h = abductions(&sung(&[("ɑ", 0.3), ("ɦ", 0.06), ("ɑ", 0.3)], 220.0));
    assert_eq!(planned_h.len(), 1);
    assert_eq!(planned_h[0].0, "ɦ");
    for (seq, why) in [
        (&[("ɑ", 0.3), ("h", 0.06), ("ɑ", 0.3)][..], "between vowels (\"ahead\")"),
        (&[("ɑ", 0.3), ("n", 0.06), ("h", 0.06), ("ɑ", 0.3)][..], "after a nasal (\"inhale\")"),
        (&[("ɑ", 0.3), ("d", 0.06), ("h", 0.06), ("ɑ", 0.3)][..], "after a voiced stop (\"road hears\")"),
    ] {
        let got = abductions(&sung(seq, 220.0));
        assert_eq!(got, planned_h, "an h {why} is not planned as ɦ: {got:?}");
    }
    for (seq, why) in [
        (&[("h", 0.06), ("ɑ", 0.3)][..], "starting the utterance"),
        (&[("ɑ", 0.3), ("_", 0.05), ("h", 0.06), ("ɑ", 0.3)][..], "after a pause or a rest"),
        (&[("ɑ", 0.3), ("s", 0.06), ("h", 0.06), ("ɑ", 0.3)][..], "after a voiceless consonant"),
        (&[("ɑ", 0.3), ("h", 0.06)][..], "ending the utterance"),
        (&[("ɑ", 0.3), ("h", 0.06), ("_", 0.05), ("ɑ", 0.3)][..], "before a pause"),
    ] {
        let got = abductions(&sung(seq, 220.0));
        let h: Vec<_> = got.iter().filter(|(l, _)| l == "h").collect();
        assert!(h.len() == 1 && h[0].1 > 0.3 && got.iter().all(|(l, _)| l != "ɦ"), "an h {why} is not voiceless: {got:?}");
    }
}

/// Sung a-h-a (vowels 0.6 s, h 60 ms, pressure 9, tension 0.55): the h dims the voice without
/// stopping it. Measured: the quietest 10 ms is 17.0 dB under the vowel at 220 Hz and 13.0 dB at
/// 440 Hz, with the voicing gate at 0.48 (voiceless, as planned before: about 28 and 31 dB, more
/// than 20 dB down for about 107 ms, gate 0). Before the voice's output became linear its limiter
/// turned the vowel down and the release lifted the h: 14.9 and 11.1 dB.
#[test]
fn a_sung_h_between_vowels_keeps_the_voice() {
    for f0 in [220.0, 440.0] {
        let (out, gates) = render(&sung(&[("a", 0.6), ("h", 0.06), ("a", 0.6)], f0), f0, 1.6);
        let (vowel, floor, gate) = (db(&out, 0.4, 0.7), floor(&out, 0.7, 1.1), lowest_gate(&gates, 0.75, 1.15));
        eprintln!("a-h-a at {f0} Hz: quietest 10 ms {:.1} dB under the vowel, voicing gate {gate:.2}", vowel - floor);
        // 18 dB: the linear voice's state at 440 Hz (it was 16 with the output limiter filling
        // the dip)
        assert!(floor > vowel - 18.0, "the h stops the voice at {f0} Hz: {:.1} dB under the vowel", vowel - floor);
        assert!(floor < vowel - 6.0, "the h is gone at {f0} Hz: only {:.1} dB under the vowel", vowel - floor);
        assert!(gate > 0.4, "the folds stop vibrating in the h at {f0} Hz: voicing gate {gate:.2}");
    }
}

/// A breath written [h̥] stays voiceless where a written h is voiced: a breathed re-attack between
/// two sung vowels (step_cry.burst's "hee, hee-hee") voiced as [ɦ] dipped only 11 dB at 494 Hz,
/// under the 13 dB that marks a new attack, and its next vowel was heard 8 ms before the attack.
#[test]
fn an_h_written_voiceless_stays_voiceless_between_voiced_sounds() {
    let after_a_pause = abductions(&sung(&[("h", 0.06), ("ɑ", 0.3)], 220.0));
    for (seq, why) in [
        (&[("ɑ", 0.3), ("h\u{325}", 0.06), ("ɑ", 0.3)][..], "between vowels"),
        (&[("ɑ", 0.3), ("n", 0.06), ("h\u{325}", 0.06), ("ɑ", 0.3)][..], "after a nasal"),
    ] {
        let got = abductions(&sung(seq, 220.0));
        assert!(got.len() == 1 && got[0].0 == "h" && got[0].1 > 0.3, "an h̥ {why} is voiced: {got:?}");
        assert_eq!(got, after_a_pause, "an h̥ {why} is not planned as an h after a pause");
    }
    let text = tokenize_ipa("ɑh\u{325}ɑ");
    assert_eq!(text.iter().map(|s| s.ipa.as_str()).collect::<Vec<_>>(), ["ɑ", "h\u{325}", "ɑ"], "IPA text drops the ring");
    let planned = plan_utterance(&text, &PlanOptions { body: BodyMix::MALE, f0: Some(220.0), ..Default::default() });
    assert!(abductions(&planned).iter().any(|(l, v)| l == "h" && *v > 0.3), "IPA text h̥ is voiced");
    assert_eq!(planned.segments[1].ipa, "h\u{325}", "the plan does not report the phone as written");
    let (written, plain) = (tokenize_ipa("ɑh\u{325}ɑ"), tokenize_ipa("ɑhɑ"));
    let durations = |segs: &[Segment]| {
        let plan = plan_utterance(segs, &PlanOptions { body: BodyMix::MALE, ..Default::default() });
        plan.segments.iter().map(|s| s.t1 - s.t0).collect::<Vec<_>>()
    };
    assert_eq!(durations(&written), durations(&plain), "h̥ is not timed as an h");
}

/// Sung a-h̥-a (vowels 0.6 s, h̥ 60 ms, pressure 9, tension 0.55): the breath stops the voice, as
/// every h did before #244. Measured: the quietest 10 ms is 28.1 dB under the vowel at 220 Hz and
/// 32.4 dB at 440 Hz, voicing gate 0 (a written h: 14.9 and 11.1 dB, gate 0.48). Since the sung
/// lung pressure follows the phonation threshold (`threshold_rise`, 1.9 times the speaking
/// pressure at 220 Hz for the male body), the h̥'s own breath noise is louder: 20.3 and 27.6 dB,
/// gate still 0. The floor is that noise, not the voice: the gate says the voice stopped.
#[test]
fn a_sung_voiceless_h_between_vowels_stops_the_voice() {
    for f0 in [220.0, 440.0] {
        let (out, gates) = render(&sung(&[("a", 0.6), ("h\u{325}", 0.06), ("a", 0.6)], f0), f0, 1.6);
        let (vowel, floor, gate) = (db(&out, 0.4, 0.7), floor(&out, 0.7, 1.1), lowest_gate(&gates, 0.75, 1.15));
        eprintln!("a-h̥-a at {f0} Hz: quietest 10 ms {:.1} dB under the vowel, voicing gate {gate:.2}", vowel - floor);
        assert!(floor < vowel - 18.0, "the h̥ keeps the voice at {f0} Hz: only {:.1} dB under the vowel", vowel - floor);
        assert!(gate < 0.05, "the folds keep vibrating in the h̥ at {f0} Hz: voicing gate {gate:.2}");
    }
}

fn planned_stop_abduction(seq: &[(&str, f64)], stop: &str) -> Option<f64> {
    let plan = sung(seq, 220.0);
    let s = plan.segments.iter().find(|s| s.ipa == stop).unwrap();
    plan.gestures.iter().find(|g| g.label_str() == "aspiration" && g.t0 >= s.t0 && g.t0 < s.t1).and_then(|g| g.targets.get(ControlKey::ABDUCTION))
}

#[test]
fn a_voiceless_stop_before_a_voiced_consonant_of_the_next_syllable_is_unreleased() {
    for (seq, why) in [
        (&[("ɑ", 0.3), ("t", 0.06), ("m", 0.06), ("ɑ", 0.3)][..], "before a nasal (\"that my\")"),
        (&[("ɑ", 0.3), ("k", 0.06), ("d", 0.06), ("ɑ", 0.3)][..], "before a voiced stop (\"black dog\")"),
        (&[("ɑ", 0.3), ("t", 0.06), ("z", 0.06), ("ɑ", 0.3)][..], "before a voiced fricative"),
        (&[("ɑ", 0.3), ("t#", 0.06), ("w", 0.06), ("ɑ", 0.3)][..], "ending a word before a glide (\"it was\")"),
        (&[("ɑ", 0.3), ("k#", 0.06), ("l", 0.06), ("ɑ", 0.3)][..], "ending a word before a liquid (\"black lake\")"),
    ] {
        let stop = seq[1].0.trim_end_matches('#');
        assert_eq!(planned_stop_abduction(seq, stop), None, "the {stop} {why} still opens the folds");
    }
    for (seq, why, opening) in [
        (&[("ɑ", 0.3), ("k", 0.06), ("l", 0.06), ("ɑ", 0.3)][..], "before a liquid in its onset (\"a clean\")", 0.22),
        (&[("ɑ", 0.3), ("t", 0.06), ("ɹ", 0.06), ("ɑ", 0.3)][..], "before a liquid in its onset (\"a tree\")", 0.22),
        (&[("ɑ", 0.3), ("t", 0.06), ("s", 0.06), ("ɑ", 0.3)][..], "before a voiceless consonant", 0.22),
        (&[("ɑ", 0.3), ("t", 0.06), ("_", 0.05), ("m", 0.06), ("ɑ", 0.3)][..], "before a pause", 0.22),
        (&[("ɑ", 0.3), ("t", 0.06), ("ɑ", 0.3)][..], "before a vowel", 0.36),
    ] {
        let stop = seq[1].0;
        assert_eq!(planned_stop_abduction(seq, stop), Some(opening), "the {stop} {why} lost its opening");
    }
}

/// Sung a-t-m-a and a-t-n-a (60 ms each, pressure 9, tension 0.55): the voice carries through the
/// stop into the nasal. Measured, at 220 / 440 Hz: the nasal's quietest 10 ms 9.5 / 8.4 dB under
/// the vowel for /m/, 9.0 / 8.4 for /n/, voicing gate 1.00 (with the stop's opening, as planned
/// before: 38 to 50 dB, the gate at 0 and under 0.5 for the nasal's first 28 ms).
#[test]
fn a_sung_nasal_after_a_voiceless_stop_is_voiced_from_its_start() {
    for f0 in [220.0, 440.0] {
        for nasal in ["m", "n"] {
            let plan = sung(&[("ɑ", 0.6), ("t", 0.06), (nasal, 0.06), ("ɑ", 0.6)], f0);
            let (out, gates) = render(&plan, f0, 1.7);
            let n = plan.segments.iter().find(|s| s.ipa == nasal).unwrap();
            let (vowel, floor, gate) = (db(&out, 0.4, 0.7), floor(&out, n.t0, n.t1), lowest_gate(&gates, n.t0, n.t1));
            eprintln!("ɑ-t-{nasal}-ɑ at {f0} Hz: the {nasal}'s quietest 10 ms {:.1} dB under the vowel, voicing gate {gate:.2}", vowel - floor);
            assert!(floor > vowel - 15.0, "the {nasal} after t is devoiced at {f0} Hz: {:.1} dB under the vowel", vowel - floor);
            assert!(gate > 0.9, "the folds stop in the {nasal} after t at {f0} Hz: voicing gate {gate:.2}");
        }
    }
}

/// A sung plan on measured boundaries (aligned phones, as `chimera render aligned` plans them).
fn sung_measured(seq: &[(&str, f64)], f0: f64, measured: bool) -> Plan {
    let segs: Vec<Segment> = seq.iter().map(|&(ipa, d)| seg(ipa, d, f0)).collect();
    plan_utterance(&segs, &PlanOptions { body: BodyMix::MALE, t0: 0.14, f0: Some(f0), sung: Some(true), measured: Some(measured), ..Default::default() })
}

/// Aligned phones mark where a vowel's voice starts. Planned with the release of the consonant's
/// glottal gesture after it (as in planned speech), an aligned vowel reached its level 30 ms late
/// after /h/ and the voiceless fricatives, 58 ms after /p t k/ (Billie Jean's lead: its onsets
/// after a rest 31 ms late against the aligned vowel in the median, the singer at his level 20 to
/// 35 ms before it). On measured boundaries the folds are back together by the consonant's end.
/// Phrase-initial C+i at 300 and 550 Hz (pressure 9, tension 0.55), the vowel's 10 ms from 20 ms
/// after its t0 against its level: 4.1 dB under it at most (/k/ at 550 Hz), where planned it was
/// 15 to 31 dB under it; the fricatives and stops as loud as planned (0.2 dB). An /h/ gets 1.2 dB
/// louder: its end is voiced as the folds close. Since the sung lung pressure follows the
/// phonation threshold (`threshold_rise`), planned onsets after the sibilants come sooner (at 300
/// Hz, /s/ -5.0 dB and /ʃ/ -10.1, the others -12.7 to -15.1; the aligned ones -0.1 and +1.3): the
/// control keeps the planned onset 3 dB under the aligned one.
#[test]
fn an_aligned_vowel_after_a_voiceless_onset_is_voiced_from_its_t0() {
    for f0 in [300.0, 550.0] {
        for (c, d) in [("h", 0.03), ("ʃ", 0.06), ("s", 0.08), ("f", 0.08), ("p", 0.06), ("t", 0.06), ("k", 0.06)] {
            let seq = [(c, d), ("i", 0.5)];
            let level = |measured: bool| {
                let plan = sung_measured(&seq, f0, measured);
                let v = plan.segments[1].t0;
                let (out, _) = render(&plan, f0, v + 0.6);
                (db(&out, v + 0.02, v + 0.03) - db(&out, v + 0.15, v + 0.45), db(&out, v - d, v))
            };
            let ((start, cons), (planned, planned_cons)) = (level(true), level(false));
            eprintln!("{c}-i at {f0} Hz: the vowel from 20 ms {start:.1} dB from its level ({planned:.1} as planned), the {c} {:.1} dB from planned", cons - planned_cons);
            assert!(start > -6.0, "the aligned vowel after {c} at {f0} Hz is late: {start:.1} dB under its level 20 ms in");
            if c != "h" {
                assert!(planned < start - 3.0, "planned speech changed: the vowel after {c} at {f0} Hz {planned:.1} dB from its level 20 ms in, {start:.1} aligned");
                assert!((cons - planned_cons).abs() < 1.0, "the {c} at {f0} Hz lost its noise: {:.1} dB from planned", cons - planned_cons);
            }
        }
    }
}

/// An aligned glottal stop after a silence keeps its planned closure: the hiccup g04 of Billie
/// Jean's lead (ʔ of 20 ms at 43.613 s, then ʌ), validated by the founder as it sounds. Planned,
/// its closure keeps the vowel silent through its first 10 ms (on the lead, whose clock runs the
/// render's 20 ms advance ahead of the plan, the voice comes 5 ms before the vowel's t0).
/// Released inside its span like the openings above, the vowel was voiced from its t0 (-16.5 dB
/// in its first 5 ms instead of -63.7), on the lead 20 ms before it, inside the ʔ: the hiccup
/// moved (+1.67 dB over 43.58 to 43.80 s). Measured here: the vowel's first 10 ms 48 to 62 dB
/// under its level as planned, 1.6 to 9.8 dB released inside the span.
#[test]
fn an_aligned_glottal_stop_after_silence_keeps_its_planned_closure() {
    for f0 in [220.0, 300.0, 550.0] {
        let seq = [("ʔ", 0.02), ("ʌ", 0.3)];
        let (planned, measured) = (sung_measured(&seq, f0, false), sung_measured(&seq, f0, true));
        let v = measured.segments[1].t0;
        let (out, _) = render(&measured, f0, v + 0.4);
        assert!(out == render(&planned, f0, v + 0.4).0, "the ʔ at {f0} Hz is not rendered as planned on measured boundaries");
        let closed = db(&out, v, v + 0.01) - db(&out, v + 0.1, v + 0.3);
        // the closure released inside the ʔ's span, as the openings are
        let mut leaky = measured.clone();
        for g in leaky.gestures.iter_mut().filter(|g| g.label_str() == "ʔ") {
            g.t1 = v - 0.01;
            g.ramp_out = 0.01;
        }
        let (out, _) = render(&leaky, f0, v + 0.4);
        let released = db(&out, v, v + 0.01) - db(&out, v + 0.1, v + 0.3);
        eprintln!("ʔ-ʌ at {f0} Hz: the vowel's first 10 ms {closed:.1} dB from its level, {released:.1} with the ʔ released inside its span");
        assert!(closed < -30.0, "the vowel after the ʔ at {f0} Hz is voiced in its first 10 ms ({closed:.1} dB): the ʔ lost its planned closure");
        assert!(released > closed + 20.0, "the check no longer tells a released closure at {f0} Hz: {released:.1} against {closed:.1}");
    }
}
