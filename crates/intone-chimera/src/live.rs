//! The held, played voice (`ic_live_*`/`ic_beat_*` in `abi.rs`): one [`chimera::engine::Engine`],
//! moved by short requests instead of a planned score. No change to `crates/chimera`: `Engine`
//! already does everything this needs (`set_artic`, `set_source`, `set_gate`, `beat_hit`,
//! `set_beat_steps`, `set_beat_tempo`, `set_beat_playing`, `telemetry`, `render`).
//!
//! Every request here is parsed and validated off the render path (between `ic_live_render`
//! calls, as the engine's own contract allows): invalid input is refused with a message and
//! leaves the engine exactly as it was.

use crate::Body;
use chimera::anatomy::human::ArticPatch;
use chimera::control::score::Label;
use chimera::engine::Engine;
use chimera::math::midi_to_hz;
use chimera::phonetics::beatbox::{BeatStep, beat_sound, parse_beat};
use chimera::phonetics::planner::vowel_artic;
use chimera::voice::human_voice::{SourcePatch, VoiceTelemetry};
use serde::Deserialize;

/// A mouth shape: the engine's `ArticPatch`, named for a JS reader (`ArticKey::name`, camelCase),
/// plus whether the tongue tip tracks the tongue body or moves on its own.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShapeRequest {
    #[serde(default)]
    pub values: ArticPatch,
    #[serde(default)]
    pub tip_free: Option<bool>,
}

impl ShapeRequest {
    fn validate(&self) -> Result<(), String> {
        for (k, x) in self.values.iter() {
            if !x.is_finite() {
                return Err(format!("shape.{} must be finite, got {x}", k.name()));
            }
        }
        Ok(())
    }
}

/// Every [`SourcePatch`] field that is set must be finite; `voiced` is a flag, not a number.
fn validate_source(patch: &SourcePatch) -> Result<(), String> {
    macro_rules! check {
        ($($f:ident),*) => {
            $(
                if let Some(x) = patch.$f
                    && !x.is_finite()
                {
                    return Err(format!("source.{} must be finite, got {x}", stringify!($f)));
                }
            )*
        };
    }
    check!(
        f0,
        glide,
        pressure,
        breathiness,
        tension,
        fry,
        roughness,
        vibrato_depth,
        vibrato_rate,
        drift,
        brightness
    );
    Ok(())
}

fn validate_midi(label: &str, m: f64) -> Result<(), String> {
    if !m.is_finite() {
        return Err(format!("{label} must be finite, got {m}"));
    }
    Ok(())
}

/// A note name ("a", IPA) turned into the body's calibrated articulation.
pub fn vowel_patch(
    ipa: &str,
    body: chimera::anatomy::human::BodyMix,
) -> Result<ArticPatch, String> {
    vowel_artic(ipa, body).ok_or_else(|| format!("unknown vowel: {ipa:?}"))
}

/// Sets the body; the performer's source and posture carry over (`Engine::set_body`'s own rule).
pub fn set_body(engine: &mut Engine, body: &Body) -> Result<(), String> {
    body.validate()?;
    engine.set_body(body.mix());
    Ok(())
}

pub fn set_artic(engine: &mut Engine, req: &ShapeRequest) -> Result<(), String> {
    req.validate()?;
    engine.set_artic(&req.values, req.tip_free);
    Ok(())
}

pub fn set_source(engine: &mut Engine, patch: &SourcePatch) -> Result<(), String> {
    validate_source(patch)?;
    engine.set_source(patch);
    Ok(())
}

pub fn set_vowel(engine: &mut Engine, ipa: &str) -> Result<(), String> {
    let patch = vowel_patch(ipa, engine.info().body)?;
    engine.set_artic(&patch, None);
    Ok(())
}

/// Starts a note: the body's pitch for `midi`, and the breath gate open at `velocity` (0..1.5,
/// the engine's own range; a plain `noteOn` uses 1).
pub fn note_on(engine: &mut Engine, midi: f64, velocity: f64) -> Result<(), String> {
    validate_midi("note", midi)?;
    validate_midi("velocity", velocity)?;
    engine.set_source(&SourcePatch::f0(midi_to_hz(midi)));
    engine.set_gate(velocity);
    Ok(())
}

pub fn note_off(engine: &mut Engine) {
    engine.set_gate(0.0);
}

/// Glides to a new pitch while a note is held, without touching the gate.
pub fn bend(engine: &mut Engine, midi: f64) -> Result<(), String> {
    validate_midi("note", midi)?;
    engine.set_source(&SourcePatch::f0(midi_to_hz(midi)));
    Ok(())
}

/// One beatbox hit, by its pattern symbol or sound name (case-insensitive either way, as
/// `parse_beat` already resolves a pattern token).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatHitRequest {
    pub id: String,
    #[serde(default)]
    pub note: Option<f64>,
    #[serde(default)]
    pub accent: Option<f64>,
}

impl BeatHitRequest {
    /// The sound's pattern symbol: `id` itself, or case-insensitively its id or its name
    /// ("kick" for "B"), so a JS caller can use whichever reads better.
    fn resolve(&self) -> Result<&'static str, String> {
        if let Some(s) = beat_sound(&self.id) {
            return Ok(s.id);
        }
        let lower = self.id.to_lowercase();
        chimera::phonetics::beatbox::BEAT_SOUNDS
            .iter()
            .find(|s| s.id.to_lowercase() == lower || s.name.to_lowercase() == lower)
            .map(|s| s.id)
            .ok_or_else(|| format!("unknown beat sound: {:?}", self.id))
    }

    fn validate(&self) -> Result<&'static str, String> {
        let id = self.resolve()?;
        if let Some(n) = self.note {
            validate_midi("beat note", n)?;
        }
        if let Some(a) = self.accent
            && !a.is_finite()
        {
            return Err(format!("beat accent must be finite, got {a}"));
        }
        Ok(id)
    }
}

pub fn beat_hit(engine: &mut Engine, req: &BeatHitRequest) -> Result<(), String> {
    let id = req.validate()?;
    engine.beat_hit(&BeatStep {
        id: Label::new(id),
        note: req.note,
        accent: req.accent,
    });
    Ok(())
}

/// Replaces the pattern from its text ("B . t ."). Unrecognised tokens are rests, as
/// `parse_beat` already treats them (so a typo mutes a step instead of failing the whole
/// pattern); `beat_hit` above is where an unknown sound is refused.
pub fn set_beat_steps(engine: &mut Engine, text: &str) {
    engine.set_beat_steps(&parse_beat(text));
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeatTempoRequest {
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub swing: Option<f64>,
}

impl BeatTempoRequest {
    fn validate(&self) -> Result<(), String> {
        if let Some(b) = self.bpm
            && !(b.is_finite() && b > 0.0)
        {
            return Err(format!("bpm must be positive and finite, got {b}"));
        }
        if let Some(s) = self.swing
            && !s.is_finite()
        {
            return Err(format!("swing must be finite, got {s}"));
        }
        Ok(())
    }
}

pub fn set_beat_tempo(engine: &mut Engine, req: &BeatTempoRequest) -> Result<(), String> {
    req.validate()?;
    engine.set_beat_tempo(req.bpm, req.swing);
    Ok(())
}

pub fn set_beat_playing(engine: &mut Engine, playing: bool) {
    engine.set_beat_playing(playing);
}

/// Header fields before `telemetry`'s own arrays in [`pack_telemetry`]'s output, in this order:
/// pharynx length, mouth length, velum port area, f0, voicing, lung pressure, output RMS, noise
/// level, noise node, gate, voice clock, beat step, then each array's length (artic, pharynx
/// areas, mouth areas, pressure RMS, flow, glottal area, glottal flow).
pub const TELEMETRY_HEADER: usize = 19;

/// Flattens a telemetry snapshot (and the beat's playhead) into `out`: the header above, then
/// each array in turn. No allocation once `out` has its final length (as
/// [`crate::Utterance::airway`] already relies on for its own buffer).
pub fn pack_telemetry(t: &VoiceTelemetry, beat_step: i64, out: &mut Vec<f32>) {
    out.clear();
    out.extend([
        t.ph_len as f32,
        t.or_len as f32,
        t.velum_port as f32,
        t.f0 as f32,
        t.voicing as f32,
        t.p_lung as f32,
        t.out_rms as f32,
        t.noise_level as f32,
        t.noise_node as f32,
        t.gate as f32,
        t.clock as f32,
        beat_step as f32,
        t.artic.len() as f32,
        t.ph_areas.len() as f32,
        t.or_areas.len() as f32,
        t.pressure_rms.len() as f32,
        t.flow.len() as f32,
        t.glottal_area.len() as f32,
        t.glottal_flow.len() as f32,
    ]);
    debug_assert_eq!(out.len(), TELEMETRY_HEADER);
    out.extend_from_slice(&t.artic);
    out.extend_from_slice(&t.ph_areas);
    out.extend_from_slice(&t.or_areas);
    out.extend_from_slice(&t.pressure_rms);
    out.extend_from_slice(&t.flow);
    out.extend_from_slice(&t.glottal_area);
    out.extend_from_slice(&t.glottal_flow);
}
