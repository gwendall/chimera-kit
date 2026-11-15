//! Parametric vocal-fold source: generates the glottal *area* waveform, which drives the
//! interactive glottal port of the airway network. Flow is computed by the network
//! (Bernoulli + inertance), so pulse skewing, F1 ripple and devoicing under oral closure
//! emerge from the physics.
//!
//! Voicing is gated physiologically:
//!  - transglottal pressure must exceed the phonation threshold (≈2–3 cmH₂O),
//!  - wide abduction (voiceless consonants, /h/) stops vibration.

use crate::math::{Drift, PI, Rng, TAU, clamp, cos, exp, js_max, js_min, pow, sin, smoothstep};
use crate::physics::CM_H2O;

#[derive(Clone, Copy, Debug)]
pub struct GlottisParams {
    /// fundamental frequency (Hz)
    pub f0: f64,
    /// peak vibratory area (cm²) at full effort
    pub amplitude: f64,
    /// abduction: static opening between the vocal processes (cm²)
    pub abduction: f64,
    /// posterior chink leakage (cm²), always open
    pub chink: f64,
    /// open quotient 0..1
    pub open_quotient: f64,
    /// fraction of the open phase spent opening (0.5 symmetric, larger = faster closing)
    pub skew: f64,
    /// 0 = smooth (raised-cosine) closure, 1 = abrupt slope at closure
    pub closure_sharpness: f64,
    /// vocal effort 0..1 (scales amplitude; pressed voice lowers OQ)
    pub effort: f64,
    /// cycle-to-cycle period perturbation (fraction, e.g. 0.006)
    pub jitter: f64,
    /// cycle-to-cycle amplitude perturbation (fraction, e.g. 0.04)
    pub shimmer: f64,
    /// vibrato depth (cents) and rate (Hz)
    pub vibrato_depth: f64,
    pub vibrato_rate: f64,
    /// slow random pitch drift (cents)
    pub drift: f64,
    /// vocal fry 0..1: low-frequency double-pulsing with short open phase
    pub fry: f64,
    /// diplophonia / period doubling 0..1 (alternating amplitude & period)
    pub diplophonia: f64,
    /// extra glottal closure force 0..1 (glottal stop / ejective: holds the folds shut)
    pub closure: f64,
    /// bifurcation 0..1: a logistic map drives per-cycle period and amplitude. Rising values walk
    /// through period doubling (subharmonics, ~0.3), period four (~0.55) into deterministic chaos (>0.62).
    pub chaos: f64,
}

/// Phonation threshold pressure at the speaking pitch (dyn/cm²).
pub const PHONATION_THRESHOLD: f64 = 2.5 * CM_H2O;

/// Share of the static opening (posterior chink, abduction) a full closure shuts; the rest leaks.
pub const CLOSURE_SEAL: f64 = 0.92;

/// The passaggio (Hz, F4): below it a voice sings with thick folds (laryngeal mechanism M1: chest,
/// modal), above it with thin folds (M2: falsetto, head voice). Men and women use both mechanisms
/// over the same range of pitches; countertenors sing M1 up to E4 and M2 from E3 (Castellengo,
/// Lamesch & Henrich 2007, ICA Madrid), so the mechanisms overlap around here and the voice
/// changes one a semitone either side of it, depending on where it comes from.
pub const REGISTER_PITCH: f64 = 350.0;

/// How much the phonation threshold pressure has risen at `q` times a mechanism's reference
/// pitch (1 at and below it). Titze (1992, JASA 91:2926) measured Pth = 0.14 + 0.06 (F0/F0n)² kPa
/// in modal voice; singers keep their lung pressure in proportion to it, about doubling it per
/// octave (Titze & Sundberg 1992, JASA 91:2936; Sundberg, Titze & Scherer 1993, J Voice 7:15), and
/// that pressure, not the pitch, makes the high notes loud.
pub fn pitch_threshold_rise(q: f64) -> f64 {
    let q = js_max(1.0, q);
    (0.14 + 0.06 * q * q) / 0.2
}

/// The rise of the phonation threshold at `f0` for a voice speaking at `speaking_f0`, in the
/// laryngeal mechanism `m2` (0 thick folds, 1 thin folds, in between while it changes). Thick
/// folds start from the speaking pitch; thin folds start from the passaggio, so above it falsetto
/// needs far less pressure than a chest voice would at the same pitch and its need grows more
/// slowly with the pitch. At the same note a voice is 8 to 10 dB quieter in M2 than in M1
/// (Castellengo et al. 2007). The voice multiplies its lung pressure and threshold by this.
pub fn threshold_rise(f0: f64, speaking_f0: f64, m2: f64) -> f64 {
    let thick = pitch_threshold_rise(f0 / speaking_f0);
    let thin = pitch_threshold_rise(f0 / REGISTER_PITCH);
    thick + (thin - thick) * m2
}

/// The highest lung pressure the push for a high note takes the lungs to (cmH2O). Professional
/// sopranos singing as loudly as they can across their range reach up to 40 cmH2O, against 5 to
/// 10 in conversational speech; loud speech and stage speech may approach the singing values
/// (Lindblom & Sundberg 2007, "The human voice in speech and singing", Springer Handbook of
/// Acoustics, ch. 16, p. 676 and Fig. 16.10, after Molinder 1997). A source that drives harder by
/// itself keeps its own pressure: the ceiling only bounds the push.
pub const PUSHED_PRESSURE_CEILING: f64 = 40.0;

pub const DEFAULT_GLOTTIS: GlottisParams = GlottisParams {
    f0: 110.0,
    amplitude: 0.16,
    abduction: 0.0,
    chink: 0.006,
    open_quotient: 0.62,
    skew: 0.62,
    closure_sharpness: 0.6,
    effort: 0.7,
    jitter: 0.004,
    shimmer: 0.03,
    vibrato_depth: 0.0,
    vibrato_rate: 6.0,
    drift: 6.0,
    fry: 0.0,
    diplophonia: 0.0,
    closure: 0.0,
    chaos: 0.0,
};

#[derive(Clone, Debug)]
pub struct ParametricGlottis {
    pub fs: f64,
    pub params: GlottisParams,
    phase: f64,
    cycle_amp: f64,
    cycle_period_scale: f64,
    cycle_index: u64,
    chaos_x: f64,
    vib_phase: f64,
    rng: Rng,
    drift: Drift,
    drift_value: f64,
    drift_counter: i32,
    pitch_factor: f64,
    /// smoothed voicing gate 0..1 (telemetry)
    pub voicing: f64,
    voicing_sm: f64,
    /// smoothed transglottal pressure (dyn/cm²)
    dp_sm: f64,
    dp_coef: f64,
    voice_coef: f64,
    /// last area (telemetry)
    pub area: f64,
    /// instantaneous f0 actually used (telemetry)
    pub f0_now: f64,
    /// phonation threshold pressure (dyn/cm²)
    pub threshold: f64,
    /// share of the static opening a full closure shuts (a glottal stop's seal)
    pub closure_seal: f64,
    // per-sample smoothing of control-rate parameters (steps in the glottal area at high airflow
    // radiate as clicks, because the output is the derivative of flow)
    static_sm: f64,
    closure_sm: f64,
    amp_sm: f64,
    sm_coef: f64,
}

impl ParametricGlottis {
    pub fn new(fs: f64) -> Self {
        ParametricGlottis {
            fs,
            params: DEFAULT_GLOTTIS,
            phase: 0.0,
            cycle_amp: 1.0,
            cycle_period_scale: 1.0,
            cycle_index: 0,
            chaos_x: 0.37,
            vib_phase: 0.0,
            rng: Rng::new(777),
            drift: Drift::new(fs / 32.0, 0.3, 4242),
            drift_value: 0.0,
            drift_counter: 0,
            pitch_factor: 1.0,
            voicing: 0.0,
            voicing_sm: 0.0,
            dp_sm: 0.0,
            dp_coef: 1.0 - exp(-TAU * 30.0 / fs),
            voice_coef: 1.0 - exp(-TAU * 25.0 / fs),
            area: 0.0,
            f0_now: 110.0,
            threshold: PHONATION_THRESHOLD,
            closure_seal: CLOSURE_SEAL,
            static_sm: 0.0,
            closure_sm: 0.0,
            amp_sm: 0.0,
            sm_coef: 1.0 - exp(-1.0 / (0.004 * fs)),
        }
    }

    /// Reset phase etc.
    pub fn reset(&mut self) {
        self.phase = 0.0;
        self.voicing_sm = 0.0;
        self.dp_sm = 0.0;
    }

    /// Advance one sample. `dp` is the instantaneous transglottal pressure (p_sub − p_supra).
    /// Returns the glottal area (cm²).
    #[inline]
    pub fn next(&mut self, dp: f64) -> f64 {
        let p = self.params;
        self.dp_sm += self.dp_coef * (dp - self.dp_sm);

        // drift and vibrato evaluated at a decimated rate (pitch modulation is slow)
        self.drift_counter -= 1;
        if self.drift_counter <= 0 {
            self.drift_counter = 32;
            self.drift_value = self.drift.step();
            self.vib_phase += ((p.vibrato_rate * 32.0) / self.fs) * (1.0 + 0.04 * self.drift_value);
            if self.vib_phase > 1.0 {
                self.vib_phase -= 1.0;
            }
            let cents = p.vibrato_depth * sin(TAU * self.vib_phase) + p.drift * self.drift_value;
            self.pitch_factor = pow(2.0, cents / 1200.0);
        }
        let mut f0 = p.f0 * self.pitch_factor;
        // fry pulls the rate down toward ~45 Hz
        if p.fry > 0.0 {
            f0 = f0 * (1.0 - p.fry) + js_min(f0, 48.0) * p.fry;
        }
        self.f0_now = f0;

        // voicing gate: pressure above threshold, adduction sufficient, not forcibly closed
        let pressure_gate = smoothstep(self.threshold * 0.8, self.threshold * 1.6, self.dp_sm);
        let adduct_gate = 1.0 - smoothstep(0.08, 0.22, self.static_sm - p.chink);
        let target = pressure_gate * adduct_gate * (1.0 - self.closure_sm);
        self.voicing_sm += self.voice_coef * (target - self.voicing_sm);
        self.voicing = self.voicing_sm;

        // phase advance with per-cycle perturbations
        self.phase += (f0 / self.fs) / self.cycle_period_scale;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
            self.cycle_index += 1;
            let alt = if self.cycle_index & 1 == 1 { 1.0 } else { -1.0 };
            let mut chaos_p = 0.0;
            let mut chaos_a = 0.0;
            if p.chaos > 0.0 {
                let r = 2.9 + 1.1 * js_min(1.0, p.chaos);
                self.chaos_x = r * self.chaos_x * (1.0 - self.chaos_x);
                if !(self.chaos_x > 0.0 && self.chaos_x < 1.0) {
                    self.chaos_x = 0.37;
                }
                let dev = self.chaos_x - 0.5;
                chaos_p = 0.45 * p.chaos * dev;
                chaos_a = 1.1 * p.chaos * dev;
            }
            self.cycle_period_scale = 1.0 + p.jitter * self.rng.gauss() + p.diplophonia * 0.08 * alt + chaos_p;
            self.cycle_period_scale = clamp(self.cycle_period_scale, 0.55, 1.8);
            self.cycle_amp = js_max(0.12, 1.0 + p.shimmer * self.rng.gauss() - p.diplophonia * 0.35 * (if alt > 0.0 { 1.0 } else { 0.0 }) + chaos_a);
        }

        // pulse shape within the cycle
        let mut oq = clamp(p.open_quotient - 0.18 * (p.effort - 0.5), 0.25, 0.98);
        if p.fry > 0.0 {
            oq = oq * (1.0 - p.fry) + 0.28 * p.fry;
        }
        let mut pulse = shape(self.phase, oq, p.skew, p.closure_sharpness);
        if p.fry > 0.3 {
            // second, weaker pulse shortly after the first (double pulsing typical of fry)
            let ph2 = self.phase - 0.38;
            if ph2 > 0.0 {
                pulse += 0.55 * smoothstep(0.3, 0.8, p.fry) * shape(ph2, oq * 0.8, p.skew, p.closure_sharpness);
            }
        }
        let effort_scale = 0.45 + 0.75 * p.effort;
        let sc = self.sm_coef;
        self.amp_sm += sc * (p.amplitude * effort_scale - self.amp_sm);
        self.closure_sm += sc * (p.closure - self.closure_sm);
        self.static_sm += sc * (p.abduction + p.chink - self.static_sm);
        let vib = self.amp_sm * self.cycle_amp * self.voicing_sm * pulse;
        let statics = self.static_sm * (1.0 - self.closure_seal * self.closure_sm);
        let a = js_max(0.0, vib + statics);
        self.area = a;
        a
    }

    pub fn cycle_phase(&self) -> f64 {
        self.phase
    }
}

/// Normalised area pulse (0..1) at cycle phase ph.
#[inline]
fn shape(ph: f64, oq: f64, skew: f64, sharp: f64) -> f64 {
    if ph >= oq {
        return 0.0;
    }
    let t = ph / oq;
    let s = clamp(skew, 0.3, 0.9);
    if t < s {
        return 0.5 - 0.5 * cos((PI * t) / s);
    }
    let u = (t - s) / (1.0 - s);
    let soft = 0.5 + 0.5 * cos(PI * u);
    let hard = cos(0.5 * PI * u);
    soft + (hard - soft) * sharp
}
