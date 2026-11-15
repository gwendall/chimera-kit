//! Offline meow prototype. No playback, samples or external services.
//! `cargo run --release -p chimera --example cat_voice -- out.wav [pitch-hz] [held-jaw]`
use chimera::creatures::{CreatureVoice, cat::CAT};
use std::fs::File;
use std::io::Write;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args
        .first()
        .ok_or("usage: cat_voice <out.wav> [pitch-hz] [held-jaw-0..1]")?;
    let pitch = args
        .get(1)
        .map(|x| x.parse::<f64>())
        .transpose()?
        .unwrap_or(550.0);
    let jaw = args.get(2).map(|x| x.parse::<f64>()).transpose()?;
    if !pitch.is_finite()
        || !(180.0..=1400.0).contains(&pitch)
        || jaw.is_some_and(|x| !x.is_finite() || !(0.0..=1.0).contains(&x))
    {
        return Err("pitch must be 180..1400 Hz; held jaw must be 0..1".into());
    }
    let mut voice = CreatureVoice::new(&CAT, 48000.0, &[(0, pitch), (1, jaw.unwrap_or(0.5))]);
    let mut samples = vec![0.0f32; 48000 * 3 / 2];
    if jaw.is_some() {
        voice.set_gate(1.0);
        voice.render(&mut samples[..48000]);
        voice.set_gate(0.0);
        voice.render(&mut samples[48000..]);
    } else {
        voice.play_call_id("meow", Some(pitch), 1.0);
        voice.render(&mut samples);
    }
    let peak = samples.iter().fold(0.0f32, |p, x| p.max(x.abs()));
    let rms =
        (samples.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt();
    // Standard mono 16-bit PCM WAV. Keep the engine's absolute level, with no normalisation.
    let bytes = (samples.len() * 2) as u32;
    let mut file = File::create(path)?;
    file.write_all(b"RIFF")?;
    file.write_all(&(36 + bytes).to_le_bytes())?;
    file.write_all(b"WAVEfmt \x10\0\0\0\x01\0\x01\0")?;
    file.write_all(&48000u32.to_le_bytes())?;
    file.write_all(&96000u32.to_le_bytes())?;
    file.write_all(b"\x02\0\x10\0data")?;
    file.write_all(&bytes.to_le_bytes())?;
    for x in samples {
        file.write_all(&((x.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes())?;
    }
    println!("{path}: 1.5 s, 48 kHz, peak {peak:.4}, RMS {rms:.4}, pitch {pitch} Hz, jaw {jaw:?}");
    Ok(())
}
