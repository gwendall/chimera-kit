//! Behavioural checks for the isolated cat prototype, separate from the historical creatures.
use chimera::airway::frequency::{find_peaks, linspace, transfer_function};
use chimera::analysis::pitch::{YinOpts, yin_pitch};
use chimera::creatures::{CreatureVoice, cat::CAT};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;
thread_local! { static ALLOCS: Cell<usize> = const { Cell::new(0) }; }
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Counting = Counting;

fn render(v: &mut CreatureVoice, seconds: f64, block: usize) -> Vec<f32> {
    let mut out = vec![0.0; (v.fs_out * seconds) as usize];
    for chunk in out.chunks_mut(block) {
        v.render(chunk);
    }
    out
}

#[test]
fn cat_meow_is_audible_reproducible_and_releases() {
    let call = |block| {
        let mut v = CreatureVoice::new(&CAT, 48000.0, &[]);
        v.play_call_id("meow", None, 1.0);
        let out = render(&mut v, 1.5, block);
        assert!(v.active_call().is_none());
        out
    };
    let out = call(128);
    assert_eq!(out, call(73), "host block size must not change the meow");
    let peak = out.iter().fold(0.0f32, |p, x| p.max(x.abs()));
    assert!(
        peak > 0.01 && peak < 0.7,
        "audible with limiter headroom: {peak}"
    );
    let rms =
        |x: &[f32]| (x.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt();
    assert!(rms(&out[2400..36000]) > 0.005);
    assert!(
        rms(&out[62400..]) < rms(&out[2400..36000]) * 0.01,
        "breath release must decay"
    );
}

#[test]
fn cat_pitch_and_jaw_change_the_acoustics() {
    for pitch in [400.0, 800.0] {
        let mut v = CreatureVoice::new(&CAT, 48000.0, &[(0, pitch), (1, 0.8), (3, 0.0)]);
        v.set_gate(1.0);
        let out = render(&mut v, 0.3, 128);
        let frame: Vec<f64> = out[9600..13696].iter().map(|x| *x as f64).collect();
        let measured = yin_pitch(
            &frame,
            48000.0,
            YinOpts {
                min_f0: Some(180.0),
                max_f0: Some(1400.0),
                ..Default::default()
            },
        );
        println!("pitch {pitch} Hz: {measured:?}");
        assert!((measured.f0 / pitch - 1.0).abs() < 0.03);
        assert!(measured.aperiodicity < 0.15);
    }
    let first_resonance = |jaw| {
        let v = CreatureVoice::new(&CAT, 48000.0, &[(1, jaw)]);
        let net = v.sim.net().unwrap();
        let pharynx = v
            .sim
            .tubes()
            .iter()
            .find(|(name, _)| *name == "pharynx")
            .unwrap()
            .1;
        let freqs = linspace(100.0, 3500.0, 700);
        let h = transfer_function(&net.linear_elements(), pharynx.first_node(), &freqs, &[]);
        find_peaks(&freqs, &h.mag, 100.0)
            .first()
            .expect("oral resonance")
            .freq
    };
    let closed = first_resonance(0.05);
    let open = first_resonance(0.9);
    println!("first resonance: jaw closed {closed:.1} Hz, open {open:.1} Hz");
    assert!(
        open > closed + 250.0,
        "mandibular closure must lower the first oral resonance"
    );
}

#[test]
fn cat_call_moves_pitch_and_jaw_and_stays_finite_at_extremes() {
    for fs in [48000.0, 96000.0] {
        let mut v = CreatureVoice::new(&CAT, fs, &[]);
        assert_eq!(v.fs, 192000.0);
        let net = v.sim.net().unwrap();
        let length: f64 = v
            .sim
            .tubes()
            .iter()
            .filter(|(name, _)| *name != "trachea")
            .map(|(_, t)| net.tube_length[t.index])
            .sum();
        assert!((length - 8.0).abs() < 1e-9);
        v.play_call_id("meow", None, 1.0);
        render(&mut v, 0.25, 128);
        let (high, open) = (v.values()[0], v.values()[1]);
        render(&mut v, 0.5, 128);
        assert!(v.values()[0] < high * 0.8 && v.values()[1] < open * 0.5);
        v.stop_call();
        v.set_gate(1.0);
        for jaw in [0.0, 1.0, 0.0] {
            for pitch in [180.0, 1400.0] {
                v.set_params(&[(0, pitch), (1, jaw), (2, 1.0), (3, 0.35), (4, 14.0)]);
                let out = render(&mut v, 0.08, 73);
                assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
                // Inspect the solver as well: CreatureVoice masks non-finite output samples.
                assert!(
                    v.sim
                        .net()
                        .unwrap()
                        .p
                        .iter()
                        .all(|x| x.is_finite() && x.abs() < 1e7)
                );
            }
        }
    }
}

#[test]
fn cat_call_and_telemetry_allocate_nothing_after_construction() {
    let mut v = CreatureVoice::new(&CAT, 48000.0, &[]);
    let mut telemetry = v.new_telemetry();
    let mut out = [0.0f32; 128];
    v.telemetry(&mut telemetry);
    let before = ALLOCS.with(Cell::get);
    drop(std::hint::black_box(vec![1u8; 16]));
    assert!(ALLOCS.with(Cell::get) > before, "allocator is counting");
    let before = ALLOCS.with(Cell::get);
    v.play_call_id("meow", Some(700.0), 1.0);
    for i in 0..600 {
        if i == 400 {
            v.set_params(&[(0, 800.0), (1, 0.1)]);
        }
        v.render(&mut out);
        v.telemetry(&mut telemetry);
    }
    v.stop_call();
    assert_eq!(ALLOCS.with(Cell::get) - before, 0);
}
