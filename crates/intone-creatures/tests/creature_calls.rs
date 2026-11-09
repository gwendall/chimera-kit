//! Every creature's calls render finite, audible audio and end promptly; the output does not
//! depend on the block size. Exercises `CreatureVoice` the same way the `cc_*` ABI does, since
//! `crates/chimera` (where `CreatureVoice` lives) is upstream's and isn't tested from here.
use chimera::creatures::{CREATURES, CreatureVoice};

const SAMPLE_RATE: f64 = 48_000.0;
/// Slack past a call's last key: the 0.05 s the automation itself holds past it (see
/// `CreatureVoice::eval_call`), plus one control step's worth of margin for every creature's
/// oversampling, rounded up generously.
const END_SLACK: f64 = 0.2;

/// Render `samples` of `voice` in blocks of `block`, in order.
fn render_blocked(voice: &mut CreatureVoice, samples: usize, block: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; samples];
    let mut at = 0;
    while at < samples {
        let n = block.min(samples - at);
        voice.render(&mut out[at..at + n]);
        at += n;
    }
    out
}

#[test]
fn every_call_renders_finite_audible_audio_and_ends_promptly() {
    chimera::creatures::init();
    for def in CREATURES.iter() {
        for (ci, call) in def.calls.iter().enumerate() {
            let last_t = call.keys.last().expect("a call has at least one key").t;
            let samples = ((last_t + END_SLACK) * SAMPLE_RATE).ceil() as usize + 1;

            let mut voice = CreatureVoice::new(def, SAMPLE_RATE, &[]);
            voice.play_call(ci, None, 1.0);
            let out = render_blocked(&mut voice, samples, 256);

            assert!(
                out.iter().all(|x| x.is_finite()),
                "{}/{}: non-finite sample",
                def.id,
                call.id
            );
            assert!(
                out.iter().any(|x| x.abs() > 1e-4),
                "{}/{}: rendered silence",
                def.id,
                call.id
            );
            assert!(
                voice.active_call().is_none(),
                "{}/{}: still active {} s past its last key",
                def.id,
                call.id,
                END_SLACK
            );
        }
    }
}

#[test]
fn block_size_does_not_change_the_output() {
    chimera::creatures::init();
    for def in CREATURES.iter() {
        for (ci, call) in def.calls.iter().enumerate() {
            let last_t = call.keys.last().unwrap().t;
            let samples = ((last_t + END_SLACK) * SAMPLE_RATE).ceil() as usize + 1;

            let mut a = CreatureVoice::new(def, SAMPLE_RATE, &[]);
            a.play_call(ci, None, 1.0);
            let out_a = render_blocked(&mut a, samples, 100);

            let mut b = CreatureVoice::new(def, SAMPLE_RATE, &[]);
            b.play_call(ci, None, 1.0);
            let out_b = render_blocked(&mut b, samples, 4096);

            assert_eq!(
                out_a, out_b,
                "{}/{}: output depends on block size",
                def.id, call.id
            );
        }
    }
}
