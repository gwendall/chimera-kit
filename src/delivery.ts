/**
 * Deliveries: how far a take departs from the voice's neutral, as plain numbers, and the named
 * moods built from them. A delivery becomes a score transform, so it composes with any other edit
 * and can be limited to a word.
 */
import type { Score } from "./layers.js";
import {
  breathier,
  compose,
  gain,
  pauses,
  range,
  rate,
  type ScoreTransform,
  shift,
  tenser,
} from "./transforms.js";

/** Departures from neutral. Every field is optional; absent means unchanged. */
export interface Delivery {
  /** Speaking-rate multiplier: 1 neutral, 1.2 faster. */
  rate?: number;
  /** Pitch shift in semitones: 0 neutral. */
  pitch?: number;
  /** Pitch excursion multiplier: 1 neutral, 0 a monotone. */
  range?: number;
  /** Level change in dB. */
  gain?: number;
  /** Air added to the voice, -1 to 1. */
  breath?: number;
  /** Pressure added to the voice, -1 (lax) to 1 (pressed). */
  tension?: number;
  /** Multiplier on the silences between words: 1 neutral. */
  pauses?: number;
}

/**
 * Named moods. The directions follow the cues that listeners use across studies of vocal emotion
 * (Juslin and Laukka, "Communication of emotions in vocal expression and music performance",
 * Psychological Bulletin 129(5), 2003): anger and joy raise the level, the pitch and its range;
 * sadness and tiredness lower all three and slow down; fear speeds up and raises the pitch. The
 * magnitudes are ours and have not been tested on listeners: change them freely.
 */
export const MOODS = {
  neutral: {},
  happy: { rate: 1.08, pitch: 2, range: 1.4, gain: 2, tension: 0.1, pauses: 0.9 },
  excited: { rate: 1.18, pitch: 3, range: 1.6, gain: 4, tension: 0.2, pauses: 0.8 },
  angry: { rate: 1.1, pitch: 2, range: 1.3, gain: 6, breath: -0.1, tension: 0.45, pauses: 0.8 },
  cold: { rate: 0.94, pitch: -1, range: 0.65, gain: 1, tension: 0.2, pauses: 1.25 },
  sad: { rate: 0.85, pitch: -2, range: 0.6, gain: -4, breath: 0.2, tension: -0.2, pauses: 1.4 },
  tired: { rate: 0.85, pitch: -2, range: 0.6, gain: -3, breath: 0.3, tension: -0.3, pauses: 1.4 },
  calm: { rate: 0.92, pitch: -1, range: 0.8, gain: -2, breath: 0.15, tension: -0.2, pauses: 1.2 },
  scared: { rate: 1.2, pitch: 4, range: 0.9, gain: 1, breath: 0.2, tension: 0.25, pauses: 0.9 },
  bored: { rate: 0.9, pitch: -1, range: 0.5, gain: -2, tension: -0.1, pauses: 1.2 },
  whisper: { gain: -10, breath: 1, tension: -0.5 },
} as const satisfies Record<string, Delivery>;

export type Mood = keyof typeof MOODS;

/**
 * The transform for a delivery or a mood, at an intensity: 0 changes nothing, 1 is the delivery
 * as written, 2 doubles it (multipliers are raised to the power, the rest are scaled).
 */
export function deliver(delivery: Delivery | Mood, intensity = 1): ScoreTransform {
  const d = atIntensity(delivery, intensity);
  const steps: ScoreTransform[] = [];
  if (d.pitch !== undefined) steps.push(shift(d.pitch));
  if (d.range !== undefined) steps.push(range(d.range));
  if (d.gain !== undefined) steps.push(gain(d.gain));
  if (d.breath !== undefined) steps.push(breathier(d.breath));
  if (d.tension !== undefined) steps.push(tenser(d.tension));
  if (d.pauses !== undefined) steps.push(pauses(d.pauses));
  if (d.rate !== undefined) steps.push(rate(d.rate));
  return steps.length > 0 ? compose(...steps) : (score: Score) => score;
}

/** A delivery's numbers at an intensity: multipliers raised to its power, the rest scaled by it. */
export function atIntensity(delivery: Delivery | Mood, intensity = 1): Delivery {
  if (!(Number.isFinite(intensity) && intensity >= 0)) {
    throw new RangeError(`chimera-kit: intensity must be zero or more, got ${intensity}`);
  }
  const d: Delivery = typeof delivery === "string" ? lookup(delivery) : delivery;
  const k = intensity;
  const out: Delivery = {};
  if (d.rate !== undefined) out.rate = d.rate ** k;
  if (d.pitch !== undefined) out.pitch = d.pitch * k;
  if (d.range !== undefined) out.range = d.range ** k;
  if (d.gain !== undefined) out.gain = d.gain * k;
  if (d.breath !== undefined) out.breath = d.breath * k;
  if (d.tension !== undefined) out.tension = d.tension * k;
  if (d.pauses !== undefined) out.pauses = d.pauses ** k;
  return out;
}

/** A delivery between two others: `t` 0 is `a`, 1 is `b`. Multipliers blend geometrically. */
export function blend(a: Delivery | Mood, b: Delivery | Mood, t: number): Delivery {
  const x = typeof a === "string" ? lookup(a) : a;
  const y = typeof b === "string" ? lookup(b) : b;
  const linear = (p = 0, q = 0) => p + (q - p) * t;
  const geometric = (p = 1, q = 1) => (p > 0 && q > 0 ? p * (q / p) ** t : linear(p, q));
  return {
    rate: geometric(x.rate, y.rate),
    pitch: linear(x.pitch, y.pitch),
    range: geometric(x.range, y.range),
    gain: linear(x.gain, y.gain),
    breath: linear(x.breath, y.breath),
    tension: linear(x.tension, y.tension),
    pauses: geometric(x.pauses, y.pauses),
  };
}

function lookup(mood: string): Delivery {
  const found = (MOODS as Record<string, Delivery>)[mood];
  if (!found) throw new RangeError(`chimera-kit: no mood "${mood}". Moods: ${Object.keys(MOODS).join(", ")}`);
  return found;
}
