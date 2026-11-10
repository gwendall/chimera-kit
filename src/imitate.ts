/**
 * `intone/imitate`: a voice profile estimated from a recording, for CHIMERA to caricature (see
 * docs/design.md's "Imitating a voice"). Pure TypeScript, no dependency, no engine import: this
 * module only measures a `Float32Array`, it never renders one. A separate entry on purpose, so
 * that `intone` itself does not grow for callers who never imitate a voice.
 *
 * `profile()` is not a clone. It reads caricature parameters off the recording (pitch and its
 * range, speaking rate, pauses, a formant-based body blend, a spectral-tilt brightness and a
 * periodicity-based breathiness, the last placed on both the delivery and the body) and returns
 * them as the small, plain-data shape CHIMERA already takes (`{ body, f0, rate, delivery }`). The
 * mappings from raw measurements to CHIMERA's own dials are fit against CHIMERA's own renders
 * (see the constants below, each with how it was measured); nothing here was guessed from audio
 * theory alone. `size`, `throat`, `tongue`, `lips`, `tension`, `fry` and `roughness` are left out:
 * see the imitate.ts commit for the round trips that ruled each one out. `body.brightness` and
 * `body.breathiness` are each left `undefined` (not written at all, so CHIMERA keeps its own
 * default) when the measurement behind them is not reliable at that reading; see `TILT_ANCHORS`
 * and `BODY_BREATHINESS_RELIABLE_BELOW` for exactly where that line is and why.
 *
 * Consent: `speakerAgreed` must be the literal `true`, checked again at runtime (a boolean
 * variable that happens to be `true` still satisfies the type, so the runtime check is not
 * redundant). It is a statement, not an audit: the caller is responsible for actually obtaining
 * the speaker's agreement. No recording ever ships in this repository.
 */

import type { Delivery } from "./delivery.js";
import type { Body } from "./engine.js";

export interface ImitateOptions {
  /** The caller's statement that the speaker agreed to be imitated this way. Must be `true`. */
  speakerAgreed: true;
}

/** The raw numbers `profile()` measured, before any CHIMERA-specific mapping. */
export interface Measured {
  durationSeconds: number;
  voicedSeconds: number;
  /** Median fundamental frequency over voiced frames, Hz. */
  f0Hz: number;
  /** Interquartile (p25-p75) spread of the voiced f0, in semitones: robust to the odd octave
   * error that a raw p10-p90 spread amplifies (see the comment on `RANGE_FIT`). */
  f0IqrSemitones: number;
  /** Syllable nuclei per second of voiced speaking time, pauses excluded. */
  nucleiPerSecond: number;
  /** Share of the time between the first and last voiced frame that is silent. */
  pauseShare: number;
  /** Mean length of an interior silent gap, seconds (0 when none was found). */
  meanPauseSeconds: number;
  /** The third formant's median frequency over confident voiced frames, Hz: a vocal-tract-length
   * proxy (shorter tract, higher F3). 0 when too few frames carried a usable estimate. */
  f3Hz: number;
  /** Median periodicity (YIN) confidence over voiced frames, 0 to 1: lower is noisier/breathier. */
  breathConfidence: number;
  /** Median spectral tilt over the same confident voiced frames as `f3Hz` (LPC envelope at 3500
   * Hz over 600 Hz, dB): positive is brighter. 0 when too few frames carried a usable estimate. */
  tiltDb: number;
}

export interface Profile {
  body: Body;
  f0: number;
  rate: number;
  delivery: Pick<Delivery, "range" | "breath" | "pauses">;
  measured: Measured;
}

const FRAME_MS = 30;
const HOP_MS = 10;
const MIN_HZ = 60;
const MAX_HZ = 500;

const MIN_DURATION_SECONDS = 0.5;
/** Full-signal RMS below this (dBFS, 1.0 full scale) is "too quiet to estimate a voice from". */
const MIN_RMS_DB = -45;
/** Fewer confident voiced frames than this (at a 10 ms hop) means too little voice was found. */
const MIN_VOICED_FRAMES = 8;

/**
 * Speaking-rate fit: nuclei/second = INTERCEPT + SLOPE * rate. Measured by rendering 6 Harvard
 * sentences at rate 0.6, 0.8, 1, 1.2 and 1.5 (male body, no style) through the built wasm and
 * counting nuclei with this file's own detector; least squares on those 5 points. Nuclei
 * counting saturates above about rate 1.5 (measured 3.66/s at 1.5 but 3.56/s at 2: fast speech
 * blurs syllables together), so recovered rate is clamped to CHIMERA's own `rate` option's
 * accepted (0, 4] but reported honestly as reliable only up to about 2.
 *
 * On a single short sentence (2 to 4 s), held-out sentences the fit never saw gave errors from
 * -62% to +51%: a handful of nuclei is too few to average away one sentence's own syllable
 * shape. Pooling 10 held-out sentences into one ~20 to 30 s recording (closer to a real
 * "recording to imitate a voice from") brought that to -12.2%, -5.6% and -4.2% at rate 0.8, 1 and
 * 1.3. This estimator needs several seconds of speech to be worth reading; see the README.
 */
const RATE_FIT = { intercept: 1.604, slope: 1.393 };
const RATE_MIN = 0.4;
const RATE_MAX = 2.5;

/**
 * Pitch-range fit: f0IqrSemitones = INTERCEPT + SLOPE * range-factor. Measured the same way, with
 * `deliver({ range: k })` at k 0.3, 0.5, 1, 1.5 and 2: 0.88, 1.46, 2.57, 3.86, 5.15 semitones,
 * least squares. A raw p10-p90 spread was tried first and threw away the fit: a handful of
 * octave-error frames at voicing onsets dominate the tails and swamp the true, much smaller,
 * range signal (measured 6 to 12 st regardless of k). The interquartile spread drops those
 * outliers and recovers a clean, nearly-through-the-origin line instead.
 */
const RANGE_FIT = { intercept: 0.126, slope: 2.512 };

/**
 * Pause fit: CHIMERA inserts silence only at punctuation, not between every word (a plain
 * Harvard sentence has none), so this is measured on sentences with commas and sentence breaks.
 * Baseline mean interior gap at `pauses: 1` (no style): 0.18 s. `pauses()` scales each gap's
 * length by its factor exactly, so the inverse is a plain ratio; this file's own gap detector
 * (silence >= 100 ms) under-counts a gap's true length, and increasingly so at larger factors
 * (likely the voiced/silence boundary's own decay tail eating a roughly fixed amount off each
 * side of every gap, which is a smaller fraction of a short gap than a long one): on 4 pooled
 * held-out sentences, recovered pauses was 0.898, 0.931 and 1.262 against true 1, 1.6 and 2.2 (a
 * growing under-estimate past factor 1). Not fixed here; see the README's honest caveat.
 */
const BASELINE_PAUSE_SECONDS = 0.18;
const PAUSES_MIN = 0.15;
const PAUSES_MAX = 4;

/**
 * Breathiness: `measured.breathConfidence` on CHIMERA's own renders at `deliver({ breath: k })`,
 * k from -1 to 0 (male body, no style otherwise; positive `breath` is a no-op here because the
 * engine's default score already carries breath 1, its ceiling - confirmed by diffing rendered
 * samples). Measured by calling the shipped `profile()` itself (not a reimplementation) and
 * reading `measured.breathConfidence`: an earlier table was fit from a debug script with its own,
 * slightly looser frame filter (noise floor + 15 dB, no confidence floor) and read back wrong on
 * held-out audio once run through `profile()`'s actual filter (noise floor + 12 dB AND confidence
 * >= 0.5, shared with f0 and rate) - that stricter filter throws out exactly the noisiest frames,
 * so confidence saturates much earlier than the mismatched table expected.
 * Pairs are (confidence, breath), confidence ascending:
 * measured 0.633@-1, 0.644@-0.85, 0.719@-0.7, 0.856@-0.6, 0.916@-0.5, 0.944@-0.4, 0.954@-0.3..0.
 * Past about -0.4 the confidence this filter sees is flat (0.944 to 0.954), so breath in
 * (-0.4, 0] all reads back near 0: this proxy only distinguishes a clearly breathy voice from a
 * clear one, not fine gradations near clear. A source that sounds as noisy as CHIMERA at breath
 * -1 gets breath -1 back, whatever the physical reason for that noise in CHIMERA's own synthesis;
 * see the README for the honest caveat this implies.
 */
const BREATH_TABLE: readonly [confidence: number, breath: number][] = [
  [0.633, -1],
  [0.644, -0.85],
  [0.719, -0.7],
  [0.856, -0.6],
  [0.916, -0.5],
  [0.944, -0.4],
  [0.954, 0],
];

/**
 * Body-mix fit: the third formant's median frequency, measured on 8 Harvard sentences per body
 * (confident voiced frames only, no style): male 2535 Hz, female 2760 Hz, child 3060 Hz. A
 * shorter tract raises every formant, F3 most reliably trackable of the three on this engine (F1
 * and F2 peak-pick unreliably on CHIMERA's child voice, likely because its formants sit close
 * together at this engine's own LPC order; see the imitate.ts commit for what was tried).
 */
const F3_ANCHORS = { male: 2535, female: 2760, child: 3060 };

/**
 * Body breathiness: the same `measured.breathConfidence` as `BREATH_TABLE`, now also read onto
 * `body.breathiness` (0 to 1), measured at `body: { breathiness: k }`, k from 0 to 1 (male body,
 * no style). Pairs are (confidence, breathiness), confidence ascending; measured on Harvard list 1
 * (the fit set): 0.877@1, 0.907@0.9, 0.924@0.8, 0.938@0.7, 0.944@0.6, 0.949@0.5, 0.953@0 (the last
 * is the top of a flat band: confidence stays 0.944 to 0.953 across breathiness 0 to 0.6, not
 * monotonic in that band on either the fit or held-out sentences). On held-out Harvard list 2
 * (pooled, male), a plain default-breathiness render (no override) measured confidence 0.9517,
 * which sits inside that same flat band and would read back as breathiness 0.16 if trusted - and
 * true 0.5 measured confidence 0.9484, only 0.003 away: the two are not reliably told apart here.
 * Below `BODY_BREATHINESS_RELIABLE_BELOW` that reading is not returned at all. Above it, recovered
 * breathiness was within 0.02 absolute at true 0.8 and 1 (0.805, 1.000; true 0.5 sits right at the
 * cutoff and is not claimed accurate, see below). `roughness` also lowers this confidence
 * (measured breathConfidence 0.953 to 0.851 across roughness 0 to 1, male, breathiness at its
 * default) by about as much as high breathiness does: a rough-but-clean voice reads back as
 * breathiness 1 at roughness 1 (confidence 0.851), and already breathiness 0.83 at roughness 0.6
 * (confidence 0.917) - inside the "reliable" zone below. Raising the cutoff would not fix this
 * (roughness and breathiness move the same measurement in the same direction by similar amounts),
 * so it is left as a known, documented confound rather than papered over: a speaker whose voice is
 * rough but not breathy will read back with some breathiness here. `tension` moves this confidence
 * less (0.958 to 0.893 across tension 0 to 1) but moves `tiltDb` a lot (see `TILT_ANCHORS`); this
 * file's measurements don't pull either apart from breathiness or brightness, so `tension` and
 * `roughness` are not returned as their own dials.
 */
const BODY_BREATHINESS_TABLE: readonly [confidence: number, breathiness: number][] = [
  [0.877, 1],
  [0.907, 0.9],
  [0.924, 0.8],
  [0.938, 0.7],
  [0.944, 0.6],
  [0.949, 0.5],
  [0.953, 0],
];

/**
 * Below this `breathConfidence`, body breathiness is reliable enough to return (see the table's
 * comment above); at or above it, `body.breathiness` is left `undefined` so CHIMERA keeps its own
 * default (0.15) rather than reporting a clean voice as somewhat breathy. Set at the table's own
 * flat-band boundary (0.944, the confidence at breathiness 0.6): a plain default-breathiness
 * render measured 0.9517 (above the cutoff, correctly excluded) and true breathiness 0.8 measured
 * 0.9232 (below it, correctly included).
 */
const BODY_BREATHINESS_RELIABLE_BELOW = 0.944;

/**
 * Brightness fit: tiltDb = INTERCEPT + SLOPE * brightness, where `tiltDb` is `measureSpectrum`'s
 * LPC-envelope tilt (3500 Hz over 600 Hz, dB), and INTERCEPT/SLOPE are themselves interpolated by
 * the already-recovered body blend (see `bodyFromF3`), the same male-to-female-to-child path
 * `F3_ANCHORS` walks. Measured by rendering Harvard list 1 (10 sentences) at
 * `body: { ...base, brightness: k }`, k 0, 0.25, 0.5, 0.75 and 1, least squares per base:
 *   male (`{}`):                     -25.02, -23.06, -19.75, -17.34, -14.89 dB
 *   female (`{ female: 1 }`):        -31.95, -28.09, -23.13, -19.63, -15.64 dB
 *   child (`{ female: 1, child: 1 }`): -23.78, -19.18, -14.22, -9.92,  -5.87 dB
 * A single male-only fit read a female recording's brightness back wrong by up to 0.4 (see the
 * imitate.ts commit that first added this dial); the slope moves almost as much as the intercept
 * across bases (10.39 male, 16.43 female, 18.03 child - not "one slope within the noise"), so both
 * are interpolated, not just the intercept. On held-out Harvard list 2 (pooled), recovered
 * brightness against this blend-interpolated fit was within 0.13 absolute at every true value
 * tested: male 0.2/0.5/0.8 -> errors -0.10/-0.04/-0.06 (unchanged from the male-only fit, since a
 * male blend interpolates to the male anchor exactly); female 0.2/0.5/0.8 -> errors
 * -0.12/-0.02/-0.05; child 0.2/0.5/0.8 -> errors -0.13/-0.08/-0.12 (the child anchor itself rests
 * on a less reliable F3 reading, see `F3_ANCHORS`'s comment, so child brightness carries that same
 * caveat). `fry` and `tension` also move this tilt (tension 0 vs 0.5 moved it about 6 dB in
 * testing, non-monotonically with `tension`), so a speaker who presses or relaxes their voice away
 * from this engine's default reads back with a biased brightness regardless of blend.
 */
const TILT_ANCHORS = {
  male: { intercept: -25.208, slope: 10.394 },
  female: { intercept: -31.905, slope: 16.434 },
  child: { intercept: -23.607, slope: 18.028 },
};

/** Interpolates `TILT_ANCHORS` by the already-recovered body blend, along the same
 * male-to-female-to-child path `bodyFromF3` produces it on. */
function tiltFit(mix: { female: number; child: number }): { intercept: number; slope: number } {
  const { male, female, child } = TILT_ANCHORS;
  if (mix.female <= 0) return male;
  if (mix.female < 1) {
    return {
      intercept: male.intercept + (female.intercept - male.intercept) * mix.female,
      slope: male.slope + (female.slope - male.slope) * mix.female,
    };
  }
  return {
    intercept: female.intercept + (child.intercept - female.intercept) * mix.child,
    slope: female.slope + (child.slope - female.slope) * mix.child,
  };
}

/**
 * Estimates a voice profile from a recording. `samples` is mono audio, nominally within -1 to 1;
 * `sampleRate` is its rate in Hz. Throws a `RangeError` when `speakerAgreed` is not exactly
 * `true`, or when the recording is too short or too quiet to estimate a voice from.
 */
export function profile(samples: Float32Array, sampleRate: number, options: ImitateOptions): Profile {
  if (options.speakerAgreed !== true) {
    throw new RangeError(
      "intone/imitate: speakerAgreed must be true: the speaker's own agreement to be imitated",
    );
  }
  if (!(Number.isFinite(sampleRate) && sampleRate > 0)) {
    throw new RangeError(`intone/imitate: sampleRate must be positive, got ${sampleRate}`);
  }
  const durationSeconds = samples.length / sampleRate;
  if (durationSeconds < MIN_DURATION_SECONDS) {
    throw new RangeError(
      `intone/imitate: recording is ${durationSeconds.toFixed(2)} s, too short to estimate a voice from (need at least ${MIN_DURATION_SECONDS} s)`,
    );
  }
  const overallRmsDb = rmsDb(samples);
  if (overallRmsDb < MIN_RMS_DB) {
    throw new RangeError(
      `intone/imitate: recording is too quiet to estimate a voice from (${overallRmsDb.toFixed(1)} dBFS)`,
    );
  }

  const frames = frameSignal(samples, sampleRate, FRAME_MS, HOP_MS);
  const rmsPerFrame = frames.map((f) => f.rmsDb);
  const noiseFloor = percentile(rmsPerFrame, 5);
  const active = rmsPerFrame.map((v) => v > noiseFloor + 12);
  const track = pitchTrack(frames, sampleRate, MIN_HZ, MAX_HZ);

  const voicedHz: number[] = [];
  const confidences: number[] = [];
  for (const [i, p] of track.entries()) {
    if (!active[i] || p.hz <= 0 || p.confidence < 0.5) continue;
    voicedHz.push(p.hz);
    confidences.push(p.confidence);
  }
  if (voicedHz.length < MIN_VOICED_FRAMES) {
    throw new RangeError(
      "intone/imitate: too little voiced speech found to estimate a voice from (too quiet, too short, or not speech)",
    );
  }

  // The median of voiced f0 (YIN, which recovers a CHIMERA render's actual pitch curve within
  // about 1 to 4 Hz on held-out sentences, verified against `score.pitch`'s own ground truth
  // median). It will still differ from a single-scalar `f0` CHIMERA was asked to render by a few
  // percent, up to about 8% on some held-out sentences: CHIMERA's own intonation is not flat, and
  // its median over a sentence depends on that sentence's stress pattern, not an estimator error.
  const f0Hz = median(voicedHz);
  const p25 = percentile(voicedHz, 25);
  const p75 = percentile(voicedHz, 75);
  const f0IqrSemitones = p25 > 0 && p75 > 0 ? 12 * Math.log2(p75 / p25) : 0;
  const breathConfidence = median(confidences);
  const voicedSeconds = active.filter(Boolean).length * (HOP_MS / 1000);

  const nuclei = countNuclei(rmsPerFrame, active, track);
  const nucleiPerSecond = voicedSeconds > 0 ? nuclei / voicedSeconds : 0;

  const { pauseShare, meanPauseSeconds } = pauseStats(active, HOP_MS / 1000);

  const { f3Hz, tiltDb } = measureSpectrum(samples, sampleRate, active, track);

  const measured: Measured = {
    durationSeconds,
    voicedSeconds,
    f0Hz,
    f0IqrSemitones,
    nucleiPerSecond,
    pauseShare,
    meanPauseSeconds,
    f3Hz,
    breathConfidence,
    tiltDb,
  };

  const rate = clamp((nucleiPerSecond - RATE_FIT.intercept) / RATE_FIT.slope, RATE_MIN, RATE_MAX);
  const range = Math.max(0, (f0IqrSemitones - RANGE_FIT.intercept) / RANGE_FIT.slope);
  const pauses = clamp(
    meanPauseSeconds > 0 ? meanPauseSeconds / BASELINE_PAUSE_SECONDS : 1,
    PAUSES_MIN,
    PAUSES_MAX,
  );
  const breath = interpolateBreath(breathConfidence, BREATH_TABLE);
  const breathiness =
    breathConfidence < BODY_BREATHINESS_RELIABLE_BELOW
      ? clamp(interpolateBreath(breathConfidence, BODY_BREATHINESS_TABLE), 0, 1)
      : undefined;
  const blend = f3Hz > 0 ? bodyFromF3(f3Hz) : { female: 0, child: 0 };
  const fit = tiltFit(blend);
  const brightness = tiltDb !== 0 ? clamp((tiltDb - fit.intercept) / fit.slope, 0, 1) : undefined;
  const body: Body = {
    ...blend,
    ...(breathiness === undefined ? {} : { breathiness }),
    ...(brightness === undefined ? {} : { brightness }),
  };

  return { body, f0: f0Hz, rate, delivery: { range, breath, pauses }, measured };
}

// --- framing and energy -----------------------------------------------------------------------

interface Frame {
  t: number;
  rmsDb: number;
  samples: Float32Array;
}

function frameSignal(samples: Float32Array, sampleRate: number, frameMs: number, hopMs: number): Frame[] {
  const frameLen = Math.round((frameMs / 1000) * sampleRate);
  const hop = Math.round((hopMs / 1000) * sampleRate);
  const frames: Frame[] = [];
  for (let start = 0; start + frameLen <= samples.length; start += hop) {
    const slice = samples.subarray(start, start + frameLen);
    frames.push({ t: start / sampleRate, rmsDb: rmsDb(slice), samples: slice });
  }
  return frames;
}

function rmsDb(x: Float32Array | ArrayLike<number>): number {
  let sumSq = 0;
  for (let i = 0; i < x.length; i++) sumSq += (x[i] as number) ** 2;
  const rms = Math.sqrt(sumSq / Math.max(1, x.length));
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx] as number;
}

function median(values: readonly number[]): number {
  return percentile(values, 50);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// --- pitch (YIN) --------------------------------------------------------------------------------

interface PitchPoint {
  hz: number;
  confidence: number;
}

/**
 * YIN pitch per frame (de Cheveigne and Kawahara, "YIN, a fundamental frequency estimator for
 * speech and music", JASA 2002). Chosen over raw autocorrelation peak-picking, which locked onto
 * a formant's shorter lag instead of the true pitch period on this engine's low male f0 (measured
 * median 490 Hz for a requested 80 Hz, an octave-and-more error); YIN's cumulative mean
 * normalized difference function does not compete those two lags directly and recovered f0
 * within about 2% across 80 to 320 Hz in the same test.
 */
function pitchTrack(frames: Frame[], sampleRate: number, minHz: number, maxHz: number): PitchPoint[] {
  const threshold = 0.15;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.ceil(sampleRate / minHz);
  return frames.map((frame) => {
    const n = frame.samples.length;
    if (maxLag + 1 >= n) return { hz: 0, confidence: 0 };
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = frame.samples[i] as number;
    const d = new Float64Array(maxLag + 1);
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) sum += ((x[i] as number) - (x[i + lag] as number)) ** 2;
      d[lag] = sum;
    }
    const cmnd = new Float64Array(maxLag + 1);
    cmnd[0] = 1;
    let running = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
      running += d[lag] as number;
      cmnd[lag] = running > 0 ? ((d[lag] as number) * lag) / running : 1;
    }
    let chosen = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if ((cmnd[lag] as number) < threshold) {
        let best = lag;
        while (best + 1 <= maxLag && (cmnd[best + 1] as number) < (cmnd[best] as number)) best++;
        chosen = best;
        break;
      }
    }
    if (chosen < 0) {
      let best = minLag;
      for (let lag = minLag + 1; lag <= maxLag; lag++)
        if ((cmnd[lag] as number) < (cmnd[best] as number)) best = lag;
      chosen = best;
    }
    const before = cmnd[chosen - 1] ?? (cmnd[chosen] as number);
    const at = cmnd[chosen] as number;
    const after = cmnd[chosen + 1] ?? at;
    const denom = before - 2 * at + after;
    const delta = denom !== 0 ? (0.5 * (before - after)) / denom : 0;
    const refinedLag = chosen + Math.max(-1, Math.min(1, delta));
    return { hz: sampleRate / refinedLag, confidence: clamp(1 - at, 0, 1) };
  });
}

// --- speaking rate: syllable nuclei -------------------------------------------------------------

/**
 * Counts energy-envelope peaks (smoothed, two-pass moving average) that land on a voiced frame,
 * are at least 2 dB above the lowest point since the last accepted peak, and are at least 110 ms
 * apart (faster than about 9 syllables/second is not plausible English speech). Fit against
 * `RATE_FIT` above.
 */
function countNuclei(rmsPerFrame: number[], active: boolean[], track: PitchPoint[]): number {
  const smoothed = movingAverage(movingAverage(rmsPerFrame, 3), 3);
  const minGapFrames = Math.round(0.11 / (HOP_MS / 1000));
  let nuclei = 0;
  let lastPeak = -Infinity;
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (!active[i] || (track[i]?.confidence ?? 0) < 0.5) continue;
    if (
      !(
        (smoothed[i] as number) >= (smoothed[i - 1] as number) &&
        (smoothed[i] as number) >= (smoothed[i + 1] as number)
      )
    ) {
      continue;
    }
    if (i - lastPeak < minGapFrames) continue;
    if (lastPeak >= 0) {
      let dip = Infinity;
      for (let j = Math.max(0, lastPeak); j <= i; j++) dip = Math.min(dip, smoothed[j] as number);
      if ((smoothed[i] as number) - dip < 2) continue;
    }
    nuclei++;
    lastPeak = i;
  }
  return nuclei;
}

function movingAverage(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j] as number;
    return sum / (hi - lo + 1);
  });
}

// --- pauses --------------------------------------------------------------------------------------

/** Interior silent gaps (between the first and last active frame) of at least 100 ms. */
function pauseStats(active: boolean[], hopSeconds: number): { pauseShare: number; meanPauseSeconds: number } {
  const firstActive = active.indexOf(true);
  const lastActive = active.lastIndexOf(true);
  if (firstActive < 0 || lastActive <= firstActive) return { pauseShare: 0, meanPauseSeconds: 0 };
  const minGapFrames = Math.round(0.1 / hopSeconds);
  let silentFrames = 0;
  let gapLen = 0;
  const gaps: number[] = [];
  for (let i = firstActive; i <= lastActive; i++) {
    if (!active[i]) {
      silentFrames++;
      gapLen++;
    } else if (gapLen > 0) {
      if (gapLen >= minGapFrames) gaps.push(gapLen * hopSeconds);
      gapLen = 0;
    }
  }
  const total = lastActive - firstActive + 1;
  return {
    pauseShare: silentFrames / total,
    meanPauseSeconds: gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0,
  };
}

// --- breath: table lookup ------------------------------------------------------------------------

/** Linear interpolation through a (confidence, dial) table, confidence ascending; clamped to the
 * table's own ends. Shared by `BREATH_TABLE` (delivery's `breath`) and `BODY_BREATHINESS_TABLE`
 * (body's `breathiness`): the same measured quantity, two different tables. */
function interpolateBreath(confidence: number, table: readonly [number, number][]): number {
  const first = table[0] as [number, number];
  const last = table[table.length - 1] as [number, number];
  if (confidence <= first[0]) return first[1];
  if (confidence >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [hiC, hiB] = table[i] as [number, number];
    if (confidence <= hiC) {
      const [loC, loB] = table[i - 1] as [number, number];
      const t = hiC === loC ? 0 : (confidence - loC) / (hiC - loC);
      return loB + (hiB - loB) * t;
    }
  }
  return last[1];
}

// --- body: a formant-based vocal-tract-length scale ----------------------------------------------

/** Downsamples by an integer factor (two-pass moving-average low-pass first) so that LPC analysis
 * has the resolution to separate formants instead of the whole telephone-to-ultrasonic span. */
function decimate(
  samples: Float32Array,
  sampleRate: number,
  targetHz: number,
): { data: Float64Array; rate: number } {
  const factor = Math.max(1, Math.round(sampleRate / targetHz));
  let data = Float64Array.from(samples);
  if (factor > 1) {
    for (let pass = 0; pass < 2; pass++) {
      const smoothed = new Float64Array(data.length);
      for (let i = 0; i < data.length; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - factor + 1); j <= i; j++) {
          sum += data[j] as number;
          count++;
        }
        smoothed[i] = sum / count;
      }
      data = smoothed;
    }
  }
  const out = new Float64Array(Math.floor(data.length / factor));
  for (let i = 0; i < out.length; i++) out[i] = data[i * factor] as number;
  return { data: out, rate: sampleRate / factor };
}

/** LPC coefficients by Levinson-Durbin, pre-emphasized (first difference) and Hann-windowed first
 * so spectral tilt doesn't swamp the formants. */
function lpc(samples: Float64Array, order: number): number[] {
  const n = samples.length;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pre = (samples[i] as number) - 0.97 * (samples[i - 1] ?? samples[0] ?? 0);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    windowed[i] = pre * w;
  }
  const r: number[] = [];
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += (windowed[i] as number) * (windowed[i + lag] as number);
    r.push(sum);
  }
  const a: number[] = new Array(order + 1).fill(0);
  a[0] = 1;
  let e = r[0] ?? 1e-9;
  for (let i = 1; i <= order; i++) {
    let acc = r[i] ?? 0;
    for (let j = 1; j < i; j++) acc += (a[j] ?? 0) * (r[i - j] ?? 0);
    const k = e !== 0 ? -acc / e : 0;
    const next = a.slice(0, i + 1);
    for (let j = 1; j < i; j++) next[j] = (a[j] ?? 0) + k * (a[i - j] ?? 0);
    next[i] = k;
    for (let j = 0; j <= i; j++) a[j] = next[j] as number;
    e *= 1 - k * k;
  }
  return a;
}

function lpcMagnitude(a: number[], hz: number, sampleRate: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  let re = 0;
  let im = 0;
  for (let k = 0; k < a.length; k++) {
    re += (a[k] ?? 0) * Math.cos(-w * k);
    im += (a[k] ?? 0) * Math.sin(-w * k);
  }
  const denom = re * re + im * im;
  return denom > 0 ? 1 / Math.sqrt(denom) : 0;
}

/** The highest LPC-envelope peak between 2000 and 4500 Hz: a proxy for the third formant, the
 * most reliably trackable of the three on this engine (see `F3_ANCHORS`'s comment). */
function f3InBand(a: number[], rate: number): number | undefined {
  let best: number | undefined;
  let bestMag = -1;
  let previous = lpcMagnitude(a, 2000 - 15, rate);
  let current = lpcMagnitude(a, 2000, rate);
  for (let hz = 2015; hz <= 4500; hz += 15) {
    const next = lpcMagnitude(a, hz, rate);
    if (current > previous && current > next && current > bestMag) {
      bestMag = current;
      best = hz - 15;
    }
    previous = current;
    current = next;
  }
  return best;
}

/**
 * The median F3 (see `f3InBand`) and spectral tilt (the LPC envelope at 3500 Hz over 600 Hz, in
 * dB: positive is brighter) over confident voiced frames, one LPC fit per frame shared by both so
 * this stays a single pass. 0 for either when too few frames carried a usable estimate.
 */
function measureSpectrum(
  samples: Float32Array,
  sampleRate: number,
  active: boolean[],
  track: PitchPoint[],
): { f3Hz: number; tiltDb: number } {
  const { data, rate } = decimate(samples, sampleRate, 10_000);
  const frames = frameSignal(Float32Array.from(data), rate, FRAME_MS, HOP_MS);
  const rmsPerFrame = frames.map((f) => f.rmsDb);
  const noiseFloor = percentile(rmsPerFrame, 5);
  const order = Math.round(rate / 1000) + 4;
  const n = Math.min(frames.length, active.length, track.length);
  const f3s: number[] = [];
  const tilts: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((rmsPerFrame[i] as number) < noiseFloor + 20) continue;
    if ((track[i]?.confidence ?? 0) < 0.65) continue;
    const a = lpc(Float64Array.from((frames[i] as Frame).samples), order);
    const f3 = f3InBand(a, rate);
    if (f3 !== undefined) f3s.push(f3);
    const lo = lpcMagnitude(a, 600, rate);
    const hi = lpcMagnitude(a, 3500, rate);
    if (lo > 0 && hi > 0) tilts.push(20 * Math.log10(hi / lo));
  }
  return { f3Hz: f3s.length > 0 ? median(f3s) : 0, tiltDb: tilts.length > 0 ? median(tilts) : 0 };
}

/**
 * Maps a measured F3 onto CHIMERA's body mix along the one path its own presets trace out:
 * male (shortest F3) to female to child (highest F3), each segment a plain linear interpolation
 * between the measured anchors. This is a single size scale, not a full timbre match: see the
 * README's caveat.
 */
function bodyFromF3(f3Hz: number): { female: number; child: number } {
  const { male, female, child } = F3_ANCHORS;
  if (f3Hz <= male) return { female: 0, child: 0 };
  if (f3Hz <= female) {
    const f = (f3Hz - male) / (female - male);
    return { female: f, child: 0 };
  }
  const extra = clamp((f3Hz - female) / (child - female), 0, 1);
  return { female: 1, child: extra };
}
