//! Prepared physical gestures on one continuous voice, with a bounded live score.
use crate::{BLOCK, Body, OVERSAMPLE, SAMPLE_RATE};
use chimera::control::score::{Gesture, GestureScore};
use chimera::voice::human_voice::{HumanVoice, SourcePatch};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Performance {
    pub version: u32,
    pub sample_rate: u32,
    pub duration: f64,
    #[serde(default)]
    pub body: Body,
    #[serde(default)]
    pub source: SourcePatch,
    pub gestures: Vec<Gesture>,
}

/// Preserve original summation order even when activation times are out of order. The final
/// gesture keeps the score nonempty during rests, exactly as a fully scheduled native plan.
struct Schedule {
    gestures: Vec<Gesture>,
    order: Vec<usize>,
    next: usize,
    tail: Option<usize>,
    started: bool,
    batch: Vec<Gesture>,
}

impl Schedule {
    fn new(gestures: Vec<Gesture>) -> Self {
        let mut order: Vec<_> = (0..gestures.len()).collect();
        order.sort_unstable_by(|&a, &b| {
            (gestures[a].t0 - gestures[a].ramp_in)
                .total_cmp(&(gestures[b].t0 - gestures[b].ramp_in))
        });
        let tail =
            (0..gestures.len()).max_by(|&a, &b| gestures[a].end().total_cmp(&gestures[b].end()));
        Self {
            gestures,
            order,
            next: 0,
            tail,
            started: false,
            batch: Vec::with_capacity(GestureScore::CAPACITY),
        }
    }

    fn refill(&mut self, score: &mut GestureScore, through: f64) -> Result<(), String> {
        let mut end = self.next;
        while end < self.order.len() {
            let g = &self.gestures[self.order[end]];
            if g.t0 - g.ramp_in > through {
                break;
            }
            end += 1;
        }
        let additions = self.order[self.next..end]
            .iter()
            .filter(|&&i| Some(i) != self.tail)
            .count()
            + usize::from(!self.started && self.tail.is_some());
        if score.size() + additions > GestureScore::CAPACITY {
            return Err("performance exceeds live gesture capacity in one second".into());
        }
        self.batch.clear();
        self.batch.extend_from_slice(score.gestures());
        if !self.started
            && let Some(i) = self.tail
        {
            let mut g = self.gestures[i];
            g.tag = Some(i as f64);
            self.batch.push(g);
        }
        for &i in &self.order[self.next..end] {
            if Some(i) == self.tail {
                continue;
            }
            let mut g = self.gestures[i];
            g.tag = Some(i as f64);
            self.batch.push(g);
        }
        self.batch
            .sort_unstable_by(|a, b| a.tag.unwrap().total_cmp(&b.tag.unwrap()));
        score.clear();
        score.add_all(&self.batch);
        self.next = end;
        self.started = true;
        Ok(())
    }
}

struct Checkpoint {
    voice: HumanVoice,
    position: usize,
    next_score: usize,
    next: usize,
    started: bool,
}

pub struct Renderer {
    pub(crate) voice: HumanVoice,
    schedule: Schedule,
    pub samples: usize,
    pub position: usize,
    next_score: usize,
    checkpoints: Vec<Checkpoint>,
}

impl Renderer {
    pub fn new(input: Performance) -> Result<Self, String> {
        input.body.validate()?;
        if input.version != 1 || input.sample_rate != SAMPLE_RATE as u32 {
            return Err("performance requires version 1 and sampleRate 48000".into());
        }
        if !input.duration.is_finite() || input.duration <= 0.0 || input.duration > 3600.0 {
            return Err("performance duration must be in (0, 3600]".into());
        }
        for g in &input.gestures {
            if ![g.t0, g.t1, g.ramp_in, g.ramp_out, g.strength]
                .iter()
                .all(|x| x.is_finite())
                || g.t1 < g.t0
                || g.ramp_in < 0.0
                || g.ramp_out < 0.0
                || g.strength < 0.0
                || g.speed.is_some_and(|v| !v.is_finite() || v <= 0.0)
                || g.release_hold.is_some_and(|v| !v.is_finite() || v < 0.0)
                || g.targets.iter().any(|(_, v)| !v.is_finite())
            {
                return Err("invalid physical gesture".into());
            }
        }
        let mut voice = HumanVoice::new(SAMPLE_RATE, input.body.anatomy(), OVERSAMPLE);
        // No speech-level compensation: compiled performances reproduce the native raw voice.
        voice.set_source(&input.source);
        let mut renderer = Self {
            voice,
            schedule: Schedule::new(input.gestures),
            samples: (input.duration * SAMPLE_RATE).round() as usize,
            position: 0,
            next_score: 0,
            checkpoints: Vec::new(),
        };
        renderer.checkpoint();
        Ok(renderer)
    }

    /// Called between synthesis blocks, outside the audio callback. Retain at most 65 states,
    /// including sample zero, without copying the static gesture plan into each checkpoint.
    pub fn checkpoint(&mut self) {
        if self.checkpoints.iter().any(|c| c.position == self.position) {
            return;
        }
        self.checkpoints.push(Checkpoint {
            voice: self.voice.clone(),
            position: self.position,
            next_score: self.next_score,
            next: self.schedule.next,
            started: self.schedule.started,
        });
        self.checkpoints.sort_unstable_by_key(|c| c.position);
        if self.checkpoints.len() > 65 {
            self.checkpoints.remove(1);
        }
    }

    /// Restore the nearest retained state at or before the requested sample. The caller renders
    /// the remaining interval, preserving the actual acoustic history rather than inventing it.
    pub fn restore(&mut self, sample: usize) -> usize {
        let c = self
            .checkpoints
            .iter()
            .rev()
            .find(|c| c.position <= sample)
            .unwrap();
        if self.position <= sample && self.position >= c.position {
            return self.position;
        }
        self.voice = c.voice.clone();
        let mut score = GestureScore::new();
        score.add_all(self.voice.score.gestures());
        self.voice.score = score;
        self.position = c.position;
        self.next_score = c.next_score;
        self.schedule.next = c.next;
        self.schedule.started = c.started;
        self.position
    }

    pub fn render(&mut self, out: &mut [f32]) -> Result<usize, String> {
        let n = out.len().min(self.samples - self.position);
        let mut written = 0;
        while written < n {
            if self.position == self.next_score {
                self.next_score = (self.position + SAMPLE_RATE as usize).min(self.samples);
                self.schedule
                    .refill(&mut self.voice.score, self.next_score as f64 / SAMPLE_RATE)?;
            }
            let count = (n - written)
                .min(self.next_score - self.position)
                .min(BLOCK);
            self.voice.render(&mut out[written..written + count]);
            self.position += count;
            written += count;
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chimera::control::score::{ControlKey, Targets};

    fn input() -> Performance {
        Performance {
            version: 1,
            sample_rate: 48000,
            duration: 2.2,
            body: Body::default(),
            source: SourcePatch {
                drift: Some(0.0),
                ..Default::default()
            },
            gestures: vec![
                Gesture::new(
                    0.0,
                    2.0,
                    0.01,
                    0.03,
                    5.0,
                    Targets::default().with(ControlKey::BREATH, 1.1),
                ),
                Gesture::new(
                    1.1,
                    1.5,
                    0.2,
                    0.05,
                    4.0,
                    Targets::default().with(ControlKey::F0, 170.0),
                ),
                Gesture::new(
                    0.4,
                    0.8,
                    0.1,
                    0.05,
                    6.0,
                    Targets::default().with(ControlKey::F0, 210.0),
                ),
            ],
        }
    }

    #[test]
    fn windowed_matches_full_plan_and_arbitrary_blocks() {
        let mut direct = HumanVoice::new(SAMPLE_RATE, Body::default().anatomy(), OVERSAMPLE);
        direct.set_source(&input().source);
        direct.schedule(&input().gestures);
        let mut expected = vec![0.0; 105600];
        direct.render(&mut expected);
        for size in [127, 4096] {
            let mut renderer = Renderer::new(input()).unwrap();
            let mut actual = vec![0.0; expected.len()];
            for block in actual.chunks_mut(size) {
                renderer.render(block).unwrap();
            }
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn long_plan_exceeds_total_capacity_without_dropping() {
        let mut p = input();
        p.duration = 200.0;
        p.gestures = (0..20000)
            .map(|i| {
                Gesture::new(
                    i as f64 * 0.01,
                    i as f64 * 0.01 + 0.02,
                    0.001,
                    0.001,
                    2.0,
                    Targets::default().with(ControlKey::F0, 110.0),
                )
            })
            .collect();
        let mut r = Renderer::new(p).unwrap();
        r.render(&mut [0.0; 48000]).unwrap();
        r.render(&mut [0.0; 128]).unwrap();
        assert_eq!(r.voice.score.dropped, 0);
        assert!(r.voice.score.size() < 200);
    }
}
