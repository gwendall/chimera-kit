//! Short closures land on their span. The planner compensates each articulator's movement
//! latency so a consonant's acoustic closure and release fall on its aligned boundaries, except
//! that a voiced /d g/ released into a vowel is released RELEASE_LAG before its span ends.
//!
//! A short /g/ did not: a floor on its gesture's end, there so a short tip or lip stop still
//! closes, held the dorsum, which releases 34 ms after its gesture ends, sealed 20 to 26 ms past
//! the end of a 20 ms span (ə-g-ɝ sealed 43 ms).
use chimera::anatomy::human::BODY_MALE;
use chimera::phonetics::planner::{PlanOptions, plan_utterance};
use chimera::phonetics::{Intonation, Plan, Segment};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};

const FS: f64 = 48000.0;
const F0: f64 = 220.0;

#[derive(Debug)]
struct Timing {
    /// the end of the consonant's span (s)
    t1: f64,
    /// first and last ms with the oral tract sealed (narrowest section under 0.001 cm²)
    seal: Option<(f64, f64)>,
    sealed_ms: usize,
}

fn plan(v1: (&str, Option<u8>), c: &str, v2: (&str, Option<u8>), dur: f64) -> Plan {
    let seg = |ipa: &str, d: f64, stress: Option<u8>| Segment {
        ipa: ipa.into(),
        dur: Some(d),
        f0: Some(F0),
        stress,
        ..Default::default()
    };
    plan_utterance(
        &[seg(v1.0, 0.4, v1.1), seg(c, dur, None), seg(v2.0, 0.4, v2.1)],
        &PlanOptions {
            body: "male".into(),
            t0: 0.04,
            f0: Some(F0),
            intonation: Some(Intonation::Flat),
            sung: Some(true),
            ..Default::default()
        },
    )
}

fn sing(v1: &str, c: &str, v2: &str, dur: f64) -> Timing {
    sing_stressed((v1, None), c, (v2, None), dur)
}

fn sing_stressed(v1: (&str, Option<u8>), c: &str, v2: (&str, Option<u8>), dur: f64) -> Timing {
    let f0 = F0;
    let plan = plan(v1, c, v2, dur);
    let s = plan.segments.iter().find(|s| s.ipa == c).unwrap();
    let (t0, t1) = (s.t0, s.t1);
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
    let mut out = vec![0f32; ((t1 + 0.2) * FS) as usize];
    let (mut seal, mut sealed_ms) = (None::<(f64, f64)>, 0);
    for (k, block) in out.chunks_mut(48).enumerate() {
        voice.render(block);
        let t = (k + 1) as f64 / 1000.0;
        if t > t0 - 0.1 && t < t1 + 0.1 {
            let net = &voice.airway.net;
            let narrowest = (oral.first..oral.first + oral.n)
                .map(|j| net.amin[j].min(net.area[j]))
                .fold(f64::INFINITY, f64::min);
            if narrowest < 1e-3 {
                sealed_ms += 1;
                seal = Some(seal.map_or((t, t), |(a, _)| (a, t)));
            }
        }
    }
    Timing { t1, seal, sealed_ms }
}

#[test]
fn a_short_velar_releases_at_the_end_of_its_span() {
    for (v1, v2) in [("ə", "ɝ"), ("a", "a"), ("ɪ", "ɪ"), ("u", "u")] {
        for dur in [0.02, 0.03, 0.06] {
            let s = sing(v1, "g", v2, dur);
            println!("{v1}g{v2} {dur}: {s:?}");
            let (_, off) = s.seal.unwrap_or_else(|| panic!("{v1}g{v2} {dur}: no closure: {s:?}"));
            assert!(s.sealed_ms >= 5, "{v1}g{v2} {dur}: no closure: {s:?}");
            assert!(
                off <= s.t1 + 0.004,
                "{v1}g{v2} {dur}: sealed {:.0} ms past its end: {s:?}",
                1000.0 * (off - s.t1)
            );
        }
    }
}

/// A voiced stop released into a vowel is released before its span ends, as TSP's speakers do
/// (RELEASE_LAG in planner.rs: 21 and 28 ms for /d g/; /b/ keeps its boundary, released early
/// it was heard as a glide). Released on the boundary, the tongue's seal lasted from 3 ms before
/// it to 2 ms past it, and /g/'s dip was 65 ms wide at half depth where the speakers' is 42. The
/// lips' seal outlasts their gesture (it ends 2 to 9 ms past the boundary): `slack` allows for it.
#[test]
fn a_voiced_stop_is_released_before_the_end_of_its_span() {
    let mut bad = vec![];
    for (c, lag, slack) in [("b", 0.0, 0.012), ("d", 0.021, 0.004), ("g", 0.028, 0.004)] {
        for (v1, v2) in [("ɑ", "ə"), ("ə", "ɝ"), ("ɪ", "ɪ"), ("u", "u")] {
            for dur in [0.06, 0.09] {
                let s = sing(v1, c, v2, dur);
                let Some((_, off)) = s.seal else {
                    bad.push(format!("{v1}{c}{v2} {dur}: no closure"));
                    continue;
                };
                let early = 1000.0 * (s.t1 - off);
                println!("{v1}{c}{v2} {dur}: sealed {} ms, until {early:.0} ms before its end", s.sealed_ms);
                if s.sealed_ms < 10 || off > s.t1 - lag + slack || off < s.t1 - lag - 0.008 {
                    bad.push(format!("{v1}{c}{v2} {dur}: sealed {} ms, until {early:.0} ms before its end", s.sealed_ms));
                }
            }
        }
    }
    assert!(bad.is_empty(), "{bad:?}");
}

/// A short /d/ from a stressed vowel into an unstressed one (where American English flaps it)
/// holds its contact briefly: TSP's speakers dip it 24 dB under 50 ms where the stop dipped 36.5.
/// From 60 ms the flap seals for less time than the stop and still seals. Under it the stop's
/// release lag (RELEASE_LAG) and the flap's late start leave both at the 12 ms minimum gesture,
/// which seals after a high vowel and no longer after /ɑ/: the flap seals at most as long as the
/// stop. TSP's flaps under 45 ms dip 24.0 dB and come back within 15 dB 17 ms before the span's
/// end; with the lag the engine's flaps dip 27.3 dB and come back 8.6 ms before it (without it
/// 28.9 dB, 0.7 ms after it).
#[test]
fn a_flapped_d_holds_its_contact_briefly() {
    let mut bad = vec![];
    for (v1, v2) in [("ɑ", "ə"), ("i", "ɪ"), ("eɪ", "i"), ("u", "ə")] {
        for dur in [0.02, 0.03, 0.04, 0.05, 0.07] {
            let flap = sing_stressed((v1, Some(1)), "d", (v2, Some(0)), dur);
            let stop = sing_stressed((v1, Some(1)), "d", (v2, Some(1)), dur);
            println!("{v1}d{v2} {dur}: flap {:?} {} ms, stop {:?} {} ms", flap.seal, flap.sealed_ms, stop.seal, stop.sealed_ms);
            let ok = if dur < 0.06 {
                flap.sealed_ms <= stop.sealed_ms
            } else {
                flap.sealed_ms >= 3 && flap.sealed_ms + 5 <= stop.sealed_ms
            };
            if !ok {
                bad.push(format!("{v1}d{v2} {dur}: flap {} ms, stop {} ms", flap.sealed_ms, stop.sealed_ms));
            }
        }
    }
    assert!(bad.is_empty(), "{bad:?}");
}

/// Before a stressed vowel, after an unstressed one, from FLAP_MAX (80 ms) on, and for any stop
/// but /d/, the closure is planned as before.
#[test]
fn a_stop_before_stress_or_long_is_planned_as_before() {
    let own = |p: &Plan, c: &str| {
        let g: Vec<_> = p.gestures.iter().filter(|g| g.label.as_ref().is_some_and(|l| l.as_str() == c)).collect();
        format!("{g:?}")
    };
    let unmarked = |c, dur| own(&plan(("ɑ", None), c, ("ə", None), dur), c);
    for c in ["b", "d", "g", "p", "t"] {
        for dur in [0.03, 0.06] {
            assert_eq!(own(&plan(("ɑ", Some(1)), c, ("ə", Some(1)), dur), c), unmarked(c, dur), "{c} {dur} before stress");
            assert_eq!(own(&plan(("ɑ", Some(0)), c, ("ə", Some(0)), dur), c), unmarked(c, dur), "{c} {dur} after an unstressed vowel");
        }
        for dur in [0.09, 0.12] {
            assert_eq!(own(&plan(("ɑ", Some(1)), c, ("ə", Some(0)), dur), c), unmarked(c, dur), "{c} {dur} long");
        }
    }
    for c in ["b", "g", "p", "t"] {
        assert_eq!(own(&plan(("ɑ", Some(1)), c, ("ə", Some(0)), 0.05), c), unmarked(c, 0.05), "{c} flapping context");
    }
    assert_ne!(own(&plan(("ɑ", Some(1)), "d", ("ə", Some(0)), 0.05), "d"), unmarked("d", 0.05), "d flap");
}
