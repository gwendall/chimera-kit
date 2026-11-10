//! Who speaks: one of the three calibrated bodies, or any body around and between them.
//!
//! CHIMERA calibrates its phoneme targets for an adult male, an adult female and a child, and
//! blends them anywhere in between (`BodyMix`). A [`BodySpec`] starts from such a blend and
//! changes what a physical model can change without a new calibration: the airway it builds (its
//! size, the throat's length, the tongue, the lips) and the voice source's settings (breathiness,
//! tension, brightness, fry, roughness, pitch). The articulation stays the blend's: the tongue
//! goes where the blend's would, in a tube of another shape, as a real speaker's would.

use chimera::anatomy::human::{BodyMix, BodyName, HumanBody};
use chimera::voice::human_voice::{DEFAULT_SOURCE, SourcePatch};
use serde::de::{self, IntoDeserializer, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};

/// Who speaks: a named body, or a body anywhere in the voice space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Body {
    Named(NamedBody),
    Spec(BodySpec),
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NamedBody {
    Male,
    Female,
    Child,
}

/// A body by its dimensions. Every field is optional: `{}` is the adult male, and a spec with only
/// `female` and `child` is exactly the blend it always was.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct BodySpec {
    /// 0 adult male … 1 adult female.
    pub female: f64,
    /// 0 adult … 1 child.
    pub child: f64,
    /// The airway's size, its lengths and widths, as a multiple of the blend's. Above 1 is a bigger
    /// airway, lower in its resonances.
    pub size: Option<f64>,
    /// The pharynx's length, as a multiple of the blend's: long against the mouth in an adult
    /// male, short in a child.
    pub throat: Option<f64>,
    /// The tongue body's size, as a multiple of the blend's.
    pub tongue: Option<f64>,
    /// The lips' width, as a multiple of the blend's.
    pub lips: Option<f64>,
    /// Speaking pitch, in semitones from the blend's own. A request's `f0` wins.
    pub pitch: Option<f64>,
    /// 0 clean … 1 breathy (the folds held apart).
    pub breathiness: Option<f64>,
    /// 0 lax … 1 pressed. A score's tension wins.
    pub tension: Option<f64>,
    /// 0 dark … 1 bright: how abruptly the folds close.
    pub brightness: Option<f64>,
    /// 0 none … 1 creaky (vocal fry).
    pub fry: Option<f64>,
    /// 0 steady … 1 rough (jitter and shimmer).
    pub roughness: Option<f64>,
}

/// How far an anatomy multiple may go. Wider than any body `bodyFromSeed` draws, narrow enough that
/// the blend's articulation still fits the tube.
pub const ANATOMY_RANGE: (f64, f64) = (0.7, 1.3);
/// How much a wider airway raises the level once the engine's own ramp is undone, as `size` to
/// this power. Fitted on "The birch canoe slid on the smooth planks." for the male, the female and
/// a female-child blend at sizes 0.8 to 1.2: the raw rise was 1.9 to 2.3 times `20 log10(size)`
/// below 1 and 0.8 to 2.3 times above (the lighter blends flatten out); 1.7 leaves every one of
/// those 18 points within 1.4 dB (`tests/body.rs`, `size_leaves_the_level_alone`).
const LEVEL_EXPONENT: f64 = 1.7;
/// How far `pitch` may go, in semitones.
pub const PITCH_RANGE: (f64, f64) = (-24.0, 24.0);

impl Default for Body {
    fn default() -> Self {
        Body::Named(NamedBody::Male)
    }
}

impl<'de> Deserialize<'de> for Body {
    /// From a name (`"female"`) or a spec (`{ "female": 1, "breathiness": 0.4 }`), with the
    /// field's own error ("unknown field `sise`") rather than an untagged enum's "did not match".
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct BodyVisitor;
        impl<'de> Visitor<'de> for BodyVisitor {
            type Value = Body;
            fn expecting(&self, f: &mut core::fmt::Formatter) -> core::fmt::Result {
                f.write_str(r#""male", "female", "child" or a body's dimensions"#)
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Body, E> {
                NamedBody::deserialize(s.into_deserializer()).map(Body::Named)
            }
            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Body, A::Error> {
                BodySpec::deserialize(de::value::MapAccessDeserializer::new(map)).map(Body::Spec)
            }
        }
        d.deserialize_any(BodyVisitor)
    }
}

impl Body {
    /// The body as a spec (a name is its preset's blend).
    pub fn spec(self) -> BodySpec {
        match self {
            Body::Named(NamedBody::Male) => BodySpec::default(),
            Body::Named(NamedBody::Female) => BodySpec {
                female: 1.0,
                ..BodySpec::default()
            },
            Body::Named(NamedBody::Child) => BodySpec {
                child: 1.0,
                ..BodySpec::default()
            },
            Body::Spec(spec) => spec,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        let spec = self.spec();
        let check = |name: &str, value: Option<f64>, (low, high): (f64, f64)| match value {
            Some(v) if !(low..=high).contains(&v) => Err(format!(
                "body.{name} must be between {low} and {high}, got {v}"
            )),
            _ => Ok(()),
        };
        let unit = (0.0, 1.0);
        check("female", Some(spec.female), unit)?;
        check("child", Some(spec.child), unit)?;
        check("size", spec.size, ANATOMY_RANGE)?;
        check("throat", spec.throat, ANATOMY_RANGE)?;
        check("tongue", spec.tongue, ANATOMY_RANGE)?;
        check("lips", spec.lips, ANATOMY_RANGE)?;
        check("pitch", spec.pitch, PITCH_RANGE)?;
        check("breathiness", spec.breathiness, unit)?;
        check("tension", spec.tension, unit)?;
        check("brightness", spec.brightness, unit)?;
        check("fry", spec.fry, unit)?;
        check("roughness", spec.roughness, unit)
    }

    /// Whether the body is only a blend of the three presets (what a live voice can take).
    pub(crate) fn is_blend(&self) -> bool {
        let s = self.spec();
        [
            s.size,
            s.throat,
            s.tongue,
            s.lips,
            s.pitch,
            s.breathiness,
            s.tension,
            s.brightness,
            s.fry,
            s.roughness,
        ]
        .iter()
        .all(Option::is_none)
    }

    /// Where the body sits between the three calibrated ones: what its phoneme targets blend.
    pub fn mix(self) -> BodyMix {
        let s = self.spec();
        BodyMix::new(s.female, s.child)
    }

    /// The airway the voice is built with: the blend's, scaled by the spec. Exactly the blend's
    /// when the spec scales nothing (a multiple of 1 changes no bit).
    pub fn anatomy(self) -> HumanBody {
        let s = self.spec();
        let b = self.mix().body();
        HumanBody {
            scale: b.scale * s.size.unwrap_or(1.0),
            pharynx: b.pharynx * s.throat.unwrap_or(1.0),
            tongue_radius: b.tongue_radius * s.tongue.unwrap_or(1.0),
            lip_width: b.lip_width * s.lips.unwrap_or(1.0),
            ..b
        }
    }

    /// The speaking pitch when a request doesn't set one.
    pub fn default_f0(self) -> f64 {
        let f0 = preset_f0(self.mix());
        match self.spec().pitch {
            Some(st) => f0 * chimera::math::pow(2.0, st / 12.0),
            None => f0,
        }
    }

    /// The voice source the body speaks with at `f0`: only the settings it sets, the engine's
    /// defaults for the rest.
    pub fn source(self, f0: f64) -> SourcePatch {
        let s = self.spec();
        SourcePatch {
            f0: Some(f0),
            breathiness: s.breathiness,
            tension: s.tension,
            brightness: s.brightness,
            fry: s.fry,
            roughness: s.roughness,
            ..SourcePatch::default()
        }
    }

    /// The gain that keeps `size` from changing the voice's level. The engine turns smaller bodies
    /// down (a ramp from the adult female's scale to the male's, for their brighter radiation) and
    /// a wider airway radiates more ([`LEVEL_EXPONENT`]): uncorrected, size 0.9 came out 7.4 dB
    /// quieter on the adult male and 1.1 1.5 dB louder, enough to set voices 11 dB apart in one
    /// chat. 1 without `size`, so the presets and the blends keep every bit.
    pub fn level(self) -> f64 {
        let Some(size) = self.spec().size else {
            return 1.0;
        };
        let blend = self.mix().body().scale;
        engine_gain(blend) / engine_gain(blend * size) / chimera::math::pow(size, LEVEL_EXPONENT)
    }

    /// The tension the voice renders with, as a planned score states it.
    pub fn tension(self) -> f64 {
        self.spec().tension.unwrap_or(DEFAULT_SOURCE.tension)
    }
}

/// The three presets' speaking pitch, blended.
pub(crate) fn preset_f0(mix: BodyMix) -> f64 {
    mix.blend(|b| match b {
        BodyName::Male => 112.0,
        BodyName::Female => 205.0,
        BodyName::Child => 250.0,
    })
}

/// `HumanVoice::new`'s output gain for a body of `scale` (crates/chimera/src/voice/human_voice.rs).
/// Copied, so a test measures the level across sizes and catches the two drifting apart.
fn engine_gain(scale: f64) -> f64 {
    if scale >= 1.0 {
        1.0
    } else if scale <= 0.9 {
        0.55
    } else {
        0.55 + 0.45 * (scale - 0.9) / 0.1
    }
}
