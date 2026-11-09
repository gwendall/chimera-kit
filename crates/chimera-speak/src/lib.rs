//! Text to speech on the CHIMERA engine, behind one small request format.
//!
//! This crate does no I/O: the caller hands it the pronouncing dictionary and reads the samples.
//! It only uses the engine's public API, so `crates/chimera` can keep tracking upstream.

pub mod abi;

use chimera::anatomy::human::{BodyMix, BodyName};
use chimera::control::score::GestureScore;
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::planner::{PhraseInput, PlanOptions, plan_phrases};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};
use serde::Deserialize;

/// Every utterance renders at this rate, whatever the audio device uses.
pub const SAMPLE_RATE: f64 = 48_000.0;
/// The block size the engine's golden renders use.
const BLOCK: usize = 128;
/// Airway steps per output sample.
const OVERSAMPLE: usize = 2;
/// Time left after the last gesture for the sound to die away.
const TAIL_SECONDS: f64 = 0.3;

/// Who speaks: a named body, or a blend of them.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum Body {
    Named(NamedBody),
    Mix { female: f64, child: f64 },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NamedBody {
    Male,
    Female,
    Child,
}

impl Default for Body {
    fn default() -> Self {
        Body::Named(NamedBody::Male)
    }
}

impl Body {
    fn mix(self) -> BodyMix {
        match self {
            Body::Named(NamedBody::Male) => BodyName::Male.into(),
            Body::Named(NamedBody::Female) => BodyName::Female.into(),
            Body::Named(NamedBody::Child) => BodyName::Child.into(),
            Body::Mix { female, child } => BodyMix::new(female, child),
        }
    }
}

/// The body's speaking pitch when the request doesn't set one.
fn default_f0(mix: BodyMix) -> f64 {
    mix.blend(|b| match b {
        BodyName::Male => 112.0,
        BodyName::Female => 205.0,
        BodyName::Child => 250.0,
    })
}

/// One thing to say. Unknown fields are refused, so a typo can't be silently ignored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub text: String,
    #[serde(default)]
    pub body: Body,
    /// Speaking-rate multiplier; above 1 is faster.
    #[serde(default)]
    pub rate: Option<f64>,
    /// Baseline pitch in Hz.
    #[serde(default)]
    pub f0: Option<f64>,
    /// Pitch excursion on stressed syllables, as a fraction.
    #[serde(default)]
    pub accent: Option<f64>,
}

impl Request {
    fn validate(&self) -> Result<(), String> {
        if let Body::Mix { female, child } = self.body {
            for (name, value) in [("female", female), ("child", child)] {
                if !(0.0..=1.0).contains(&value) {
                    return Err(format!("body.{name} must be between 0 and 1, got {value}"));
                }
            }
        }
        if let Some(rate) = self.rate
            && !(rate.is_finite() && rate > 0.0 && rate <= 4.0)
        {
            return Err(format!("rate must be in (0, 4], got {rate}"));
        }
        if let Some(f0) = self.f0
            && !(20.0..=2000.0).contains(&f0)
        {
            return Err(format!("f0 must be between 20 and 2000 Hz, got {f0}"));
        }
        if let Some(accent) = self.accent
            && !(0.0..=4.0).contains(&accent)
        {
            return Err(format!("accent must be between 0 and 4, got {accent}"));
        }
        Ok(())
    }
}

/// Turns requests into utterances. Holds the pronouncing dictionary.
#[derive(Default)]
pub struct Speaker {
    g2p: EnglishG2P,
}

impl Speaker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Loads CMUdict text ("word\tPHONES" lines). Without it, spelling rules guess each word.
    pub fn load_dictionary(&mut self, text: &str) {
        self.g2p.load_dict(text);
    }

    pub fn utterance(&self, request: &Request) -> Result<Utterance, String> {
        request.validate()?;
        let phrases = self.g2p.to_phrases(&request.text);
        if phrases.iter().all(|p| p.segments.is_empty()) {
            return Err("nothing to say: the text has no pronounceable words".into());
        }
        let mix = request.body.mix();
        let f0 = request.f0.unwrap_or_else(|| default_f0(mix));
        let inputs: Vec<PhraseInput> = phrases
            .into_iter()
            .map(|p| PhraseInput {
                segments: p.segments,
                intonation: Some(p.intonation),
                pause: Some(p.pause),
            })
            .collect();
        let plan = plan_phrases(
            &inputs,
            &PlanOptions {
                body: mix,
                // Speech starts at the first sample: any silence here is latency in a chat.
                t0: 0.0,
                f0: Some(f0),
                rate: request.rate,
                accent: request.accent,
                ..Default::default()
            },
        );
        // The score has a fixed capacity and drops what doesn't fit: refuse rather than truncate.
        if plan.gestures.len() > GestureScore::CAPACITY {
            return Err("text too long for one utterance: split it into sentences".into());
        }
        let mut voice = HumanVoice::new(SAMPLE_RATE, mix.body(), OVERSAMPLE);
        voice.set_source(&SourcePatch::f0(f0));
        voice.schedule(&plan.gestures);
        let total = ((plan.end + TAIL_SECONDS) * SAMPLE_RATE).round() as usize;
        Ok(Utterance {
            voice,
            left: total,
            total,
        })
    }
}

/// Speech being rendered, a chunk at a time.
pub struct Utterance {
    voice: HumanVoice,
    left: usize,
    total: usize,
}

impl Utterance {
    /// The utterance's length in samples.
    pub fn total_samples(&self) -> usize {
        self.total
    }

    /// Fills the start of `out` with the next samples and returns how many; 0 means finished.
    pub fn render(&mut self, out: &mut [f32]) -> usize {
        let n = out.len().min(self.left);
        for block in out[..n].chunks_mut(BLOCK) {
            self.voice.render(block);
        }
        self.left -= n;
        n
    }
}
