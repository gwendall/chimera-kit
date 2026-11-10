//! Text to speech on the CHIMERA engine, behind one small request format.
//!
//! This crate does no I/O: the caller hands it the pronouncing dictionary and reads the samples.
//! It only uses the engine's public API, so `crates/chimera` can keep tracking upstream.

pub mod abi;
pub mod body;
pub mod live;
pub mod score;
pub mod sing;

pub use body::{Body, BodySpec, NamedBody};
use chimera::control::score::GestureScore;
use chimera::phonetics::english::EnglishG2P;
use chimera::phonetics::planner::{PhraseInput, PlanOptions, plan_phrases};
use chimera::voice::human_voice::HumanVoice;
use score::Score;
use serde::Deserialize;

/// Every utterance renders at this rate, whatever the audio device uses.
pub const SAMPLE_RATE: f64 = 48_000.0;
/// The block size the engine's golden renders use.
const BLOCK: usize = 128;
/// Airway steps per output sample.
const OVERSAMPLE: usize = 2;
/// Time left after the last gesture for the sound to die away.
pub(crate) const TAIL_SECONDS: f64 = 0.3;

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
        self.body.validate()?;
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

/// A score to render, as an utterance of a given body.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScoreRequest {
    pub score: Score,
    #[serde(default)]
    pub body: Body,
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
        let f0 = request.f0.unwrap_or_else(|| request.body.default_f0());
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
        let mut voice = HumanVoice::new(SAMPLE_RATE, request.body.anatomy(), OVERSAMPLE);
        voice.set_source(&request.body.source(f0));
        voice.schedule(&plan.gestures);
        let total = ((plan.end + TAIL_SECONDS) * SAMPLE_RATE).round() as usize;
        Ok(Utterance {
            voice,
            left: total,
            total,
            level: request.body.level(),
            loudness: None,
        })
    }

    /// Plans an utterance the same way [`Speaker::utterance`] does, but hands back the score
    /// instead of rendering it: layer 2 of `docs/design.md`, with exact timing and a pitch curve
    /// a test can measure.
    pub fn plan(&self, request: &Request) -> Result<Score, String> {
        request.validate()?;
        let phrases = self.g2p.to_phrases(&request.text);
        if phrases.iter().all(|p| p.segments.is_empty()) {
            return Err("nothing to say: the text has no pronounceable words".into());
        }
        let mix = request.body.mix();
        let f0 = request.f0.unwrap_or_else(|| request.body.default_f0());
        let inputs: Vec<PhraseInput> = phrases
            .iter()
            .map(|p| PhraseInput {
                segments: p.segments.clone(),
                intonation: Some(p.intonation),
                pause: Some(p.pause),
            })
            .collect();
        let plan = plan_phrases(
            &inputs,
            &PlanOptions {
                body: mix,
                t0: 0.0,
                f0: Some(f0),
                rate: request.rate,
                accent: request.accent,
                ..Default::default()
            },
        );
        if plan.gestures.len() > GestureScore::CAPACITY {
            return Err("text too long for one utterance: split it into sentences".into());
        }
        Ok(score::from_plan(
            &plan,
            &phrases,
            f0,
            request.body.tension(),
        ))
    }

    /// Plans a melody with lyrics into a score, the way [`Speaker::plan`] plans text: see
    /// `sing::sing`.
    pub fn sing(&self, request: &sing::SingRequest) -> Result<Score, String> {
        sing::sing(&self.g2p, request)
    }

    /// Renders a score exactly: its sound boundaries, and its pitch and breath curves. Refuses a
    /// `tension` curve that changes over time (CHIMERA sets tension once per utterance) and any
    /// other invalid score, naming the offending field.
    pub fn utterance_from_score(&self, request: &ScoreRequest) -> Result<Utterance, String> {
        let mix = request.body.mix();
        let (plan, tension) = score::plan_from_score(&request.score, mix)?;
        if plan.gestures.len() > GestureScore::CAPACITY {
            return Err("score too long for one utterance: split it into pieces".into());
        }
        let f0 = request
            .score
            .pitch
            .first()
            .map_or_else(|| request.body.default_f0(), |p| p[1]);
        let mut voice = HumanVoice::new(SAMPLE_RATE, request.body.anatomy(), OVERSAMPLE);
        let mut patch = request.body.source(f0);
        if tension.is_some() {
            patch.tension = tension;
        }
        voice.set_source(&patch);
        voice.schedule(&plan.gestures);
        let total = (request.score.duration * SAMPLE_RATE).round() as usize;
        Ok(Utterance {
            voice,
            left: total,
            total,
            level: request.body.level(),
            loudness: request.score.loudness.clone(),
        })
    }
}

/// Speech being rendered, a chunk at a time.
pub struct Utterance {
    voice: HumanVoice,
    left: usize,
    total: usize,
    /// The body's level correction (`Body::level`), applied to every sample.
    level: f64,
    /// A score's `loudness` curve (dB), applied as a gain on the rendered samples: CHIMERA has no
    /// per-time control for it, but any curve can be followed exactly this way.
    loudness: Option<score::Curve>,
}

impl Utterance {
    /// The airway as it is now, written over `out`: the velum port's area (cm²), the pharynx's and
    /// the mouth's lengths (cm), the number of sections of the pharynx, the mouth and the nose, then
    /// each section's area (cm²) from the glottis to the lips and on to the nostrils, then each
    /// section's pressure, in the same order.
    pub fn airway(&self, out: &mut Vec<f32>) {
        let a = &self.voice.airway;
        let tubes = [&a.pharynx, &a.oral, &a.nasal];
        out.clear();
        out.extend([
            a.net.port_area[a.velum_port] as f32,
            a.ph_len as f32,
            a.or_len as f32,
        ]);
        out.extend(tubes.iter().map(|t| t.n as f32));
        for values in [&a.net.area, &a.net.p] {
            out.extend(
                tubes
                    .iter()
                    .flat_map(|t| (0..t.n).map(|i| values[t.node(i)] as f32)),
            );
        }
    }

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
        if self.level != 1.0 {
            for x in &mut out[..n] {
                *x = (f64::from(*x) * self.level) as f32;
            }
        }
        if let Some(curve) = &self.loudness {
            let start = self.total - self.left;
            for (i, x) in out[..n].iter_mut().enumerate() {
                let t = (start + i) as f64 / SAMPLE_RATE;
                let gain = chimera::math::db_to_gain(score::curve_value(curve, t));
                *x = (f64::from(*x) * gain) as f32;
            }
        }
        self.left -= n;
        n
    }
}
