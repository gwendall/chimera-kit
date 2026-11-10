/**
 * Pure transforms of a score (layer 2). Each returns a new score and never modifies its input.
 * A scope limits a transform to a span of time; a scoped change ramps in and out inside the span,
 * so that an edit never clicks.
 */
import type { Curve, Score, Sound } from "./layers.js";

/** A stretch of time in a score, in seconds. */
export interface Span {
  t0: number;
  t1: number;
}

/** A score-to-score function. Transforms that move time say how, so that scopes can follow. */
export interface ScoreTransform {
  (score: Score, scope?: Span): Score;
  /** Where time `t` lands after the transform, when it moves time. */
  warp?: (t: number, score: Score, scope?: Span) => number;
}

/** How long a scoped change takes to come in and to go out (s). */
export const RAMP = 0.03;
/** Spacing of the points added where a change ramps (s). */
const STEP = 0.01;
/** The silence sound. */
const SILENCE = "_";

/** Applies transforms in order, each scope moved by the time changes before it. */
export function compose(...transforms: ScoreTransform[]): ScoreTransform {
  const run = (score: Score, scope: Span | undefined, time?: number) => {
    let current = score;
    let span = scope;
    let t = time;
    for (const transform of transforms) {
      const next = transform(current, span);
      const { warp } = transform;
      if (warp) {
        const before = current;
        const within = span;
        const move = (x: number) => warp(x, before, within);
        if (t !== undefined) t = move(t);
        if (within) span = { t0: move(within.t0), t1: move(within.t1) };
      }
      current = next;
    }
    return { score: current, time: t };
  };
  const composed: ScoreTransform = (score, scope) => run(score, scope).score;
  if (transforms.some((x) => x.warp))
    composed.warp = (t, score, scope) => run(score, scope, t).time as number;
  return composed;
}

/** The value of a curve at time `t`: linear between points, held past the ends. */
export function valueAt(curve: Curve, t: number): number | undefined {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return undefined;
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((curve[mid] as [number, number])[0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, v0] = curve[lo] as [number, number];
  const [t1, v1] = curve[hi] as [number, number];
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/** Lengthens a span by `factor` (2 is twice as long); what follows moves later. */
export function stretch(factor: number): ScoreTransform {
  if (!(Number.isFinite(factor) && factor > 0)) {
    throw new RangeError(`intone: stretch factor must be positive, got ${factor}`);
  }
  const warp = (t: number, score: Score, scope?: Span) => {
    const { t0, t1 } = scope ?? whole(score);
    if (t <= t0) return t;
    if (t <= t1) return t0 + (t - t0) * factor;
    return t + (t1 - t0) * (factor - 1);
  };
  const transform: ScoreTransform = (score, scope) => {
    const { t0, t1 } = scope ?? whole(score);
    return retime(score, (t) => warp(t, score, scope), [t0, t1]);
  };
  transform.warp = warp;
  return transform;
}

/**
 * Multiplies the length of the silences between words by `factor` (the silences before the
 * first sound and after the last one are left alone).
 */
export function pauses(factor: number): ScoreTransform {
  if (!(Number.isFinite(factor) && factor > 0)) {
    throw new RangeError(`intone: a pause factor must be positive, got ${factor}`);
  }
  const inner = (score: Score, scope?: Span) => {
    const { t0, t1 } = scope ?? whole(score);
    const last = score.sounds.length - 1;
    return score.sounds.filter(
      (s, i) => s.sound === SILENCE && i > 0 && i < last && s.t0 >= t0 && s.t1 <= t1,
    );
  };
  const warp = (t: number, score: Score, scope?: Span) => {
    let moved = t;
    for (const s of inner(score, scope)) {
      if (t >= s.t1) moved += (s.t1 - s.t0) * (factor - 1);
      else if (t > s.t0) moved += (t - s.t0) * (factor - 1);
    }
    return moved;
  };
  const transform: ScoreTransform = (score, scope) => {
    const silences = inner(score, scope);
    if (silences.length === 0) return score;
    return retime(
      score,
      (t) => warp(t, score, scope),
      silences.flatMap((s) => [s.t0, s.t1]),
    );
  };
  transform.warp = warp;
  return transform;
}

/** Moves every time of a score through a monotone map; `kinks` are where the map bends. */
function retime(score: Score, w: (t: number) => number, kinks: number[]): Score {
  const curve = (c: Curve | undefined) =>
    c && withPoints(c, kinks).map(([t, v]): [number, number] => [w(t), v]);
  return {
    ...score,
    duration: w(score.duration),
    sounds: score.sounds.map((s) => ({ ...s, t0: w(s.t0), t1: w(s.t1) })),
    pitch: curve(score.pitch) as Curve,
    ...optional("loudness", curve(score.loudness)),
    ...optional("breath", curve(score.breath)),
    ...optional("tension", curve(score.tension)),
    ...optional(
      "words",
      score.words?.map((x) => ({ ...x, t0: w(x.t0), t1: w(x.t1) })),
    ),
  };
}

/** Speaks a span `r` times as fast (0.5 is half speed). */
export function rate(r: number): ScoreTransform {
  if (!(Number.isFinite(r) && r > 0)) throw new RangeError(`intone: rate must be positive, got ${r}`);
  return stretch(1 / r);
}

/**
 * Inserts `seconds` of silence at time `requested`, or at the end of the phone it falls inside. A
 * silence that touches that point grows; otherwise a new one is inserted, so that a pause never
 * lengthens a phone.
 */
export function pauseAt(requested: number, seconds: number): ScoreTransform {
  if (!(Number.isFinite(seconds) && seconds >= 0)) {
    throw new RangeError(`intone: a pause must last zero seconds or more, got ${seconds}`);
  }
  const warp = (t: number, score: Score) => (t > boundary(score, requested) ? t + seconds : t);
  const transform: ScoreTransform = (score) => {
    if (seconds === 0) return score;
    const at = boundary(score, requested);
    const silence = score.sounds.findIndex((s) => s.sound === SILENCE && s.t0 <= at && at <= s.t1);
    const sounds: Sound[] = [];
    for (const [index, s] of score.sounds.entries()) {
      if (index === silence) {
        sounds.push({ ...s, t1: s.t1 + seconds, t0: s.t0 > at ? s.t0 + seconds : s.t0 });
        continue;
      }
      if (silence < 0 && s.t0 >= at && !sounds.some((x) => x.sound === SILENCE && x.t0 === at)) {
        sounds.push({ sound: SILENCE, t0: at, t1: at + seconds });
      }
      sounds.push({ ...s, t0: s.t0 >= at ? s.t0 + seconds : s.t0, t1: s.t1 > at ? s.t1 + seconds : s.t1 });
    }
    if (silence < 0 && at >= (score.sounds[score.sounds.length - 1]?.t1 ?? 0)) {
      sounds.push({ sound: SILENCE, t0: at, t1: at + seconds });
    }
    const curve = (c: Curve | undefined): Curve | undefined => {
      if (!c || c.length === 0) return c;
      const held = valueAt(c, at) as number;
      const before = c.filter(([t]) => t < at);
      const after = c.filter(([t]) => t > at).map(([t, v]): [number, number] => [t + seconds, v]);
      return [...before, [at, held], [at + seconds, held], ...after];
    };
    return {
      ...score,
      duration: score.duration + seconds,
      sounds,
      pitch: curve(score.pitch) as Curve,
      ...optional("loudness", curve(score.loudness)),
      ...optional("breath", curve(score.breath)),
      ...optional("tension", curve(score.tension)),
      ...optional(
        "words",
        score.words?.map((x) => ({
          ...x,
          t0: x.t0 >= at ? x.t0 + seconds : x.t0,
          t1: x.t1 > at ? x.t1 + seconds : x.t1,
        })),
      ),
    };
  };
  transform.warp = warp;
  return transform;
}

/** Raises the pitch by `semitones` (negative lowers), or by a string such as `"+3st"` or `"-50c"`. */
export function shift(amount: number | string): ScoreTransform {
  const semitones = parseInterval(amount);
  return (score, scope) => modulate(score, scope, "pitch", 0, (v, w) => v * 2 ** ((semitones * w) / 12));
}

/**
 * Scales the pitch range around its mean: 2 doubles every excursion (in semitones), 0 flattens
 * the span to a monotone.
 */
export function range(factor: number): ScoreTransform {
  if (!(Number.isFinite(factor) && factor >= 0)) {
    throw new RangeError(`intone: a pitch range factor must be zero or more, got ${factor}`);
  }
  return (score, scope) => {
    const reference = meanPitch(score, scope ?? whole(score));
    if (reference === undefined) return score;
    return modulate(
      score,
      scope,
      "pitch",
      0,
      (v, w) => reference * (v / reference) ** (1 + (factor - 1) * w),
    );
  };
}

/** Changes the level by `db` decibels. */
export function gain(db: number): ScoreTransform {
  return (score, scope) => modulate(score, scope, "loudness", 0, (v, w) => v + db * w);
}

/** Adds air to the voice, from -1 to 1 (a score without a breath curve starts from 0). */
export function breathier(amount: number): ScoreTransform {
  return (score, scope) => modulate(score, scope, "breath", 0, (v, w) => clamp01(v + amount * w));
}

/**
 * Presses the voice, from -1 (laxer) to 1. A score without a tension curve starts from the
 * engine's neutral 0.5; a planned score states its voice's own.
 */
export function tenser(amount: number): ScoreTransform {
  return (score, scope) => modulate(score, scope, "tension", 0.5, (v, w) => clamp01(v + amount * w));
}

/** Longer, higher and louder, by `amount` from 0 to 1 and more. */
export function emphasize(amount = 1): ScoreTransform {
  return compose(
    shift(EMPHASIS.semitones * amount),
    gain(EMPHASIS.db * amount),
    stretch(1 + EMPHASIS.lengthen * amount),
  );
}

/** What full emphasis does to a span. */
export const EMPHASIS = { semitones: 1.5, db: 3, lengthen: 0.2 } as const;

/** Reads `+3st`, `-2.5st`, `+50c` or a number of semitones. */
export function parseInterval(amount: number | string): number {
  if (typeof amount === "number") {
    if (Number.isFinite(amount)) return amount;
  } else {
    const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*(st|c)\s*$/.exec(amount);
    if (match) return Number(match[1]) / (match[2] === "c" ? 100 : 1);
  }
  throw new RangeError(
    `intone: expected semitones like "+3st", cents like "-50c" or a number, got ${amount}`,
  );
}

type CurveName = "pitch" | "loudness" | "breath" | "tension";

/** Applies `change(value, weight)` to a curve, with weight 1 inside the scope and ramps at its edges. */
function modulate(
  score: Score,
  scope: Span | undefined,
  name: CurveName,
  absent: number,
  change: (value: number, weight: number) => number,
): Score {
  const span = scope ?? whole(score);
  const source: Curve = score[name] ?? [[0, absent]];
  if (source.length === 0) return score;
  const ramp = scope ? Math.min(RAMP, (span.t1 - span.t0) / 2) : 0;
  const weight = (t: number) => {
    if (t < span.t0 || t > span.t1) return 0;
    if (ramp === 0) return 1;
    return Math.min(1, (t - span.t0) / ramp, (span.t1 - t) / ramp);
  };
  const extra = [span.t0, span.t1];
  for (let t = span.t0; ramp > 0 && t < span.t0 + ramp; t += STEP) extra.push(t);
  for (let t = span.t1 - ramp; ramp > 0 && t < span.t1; t += STEP) extra.push(t);
  extra.push(span.t0 + ramp, span.t1 - ramp);
  const changed = withPoints(source, extra).map(([t, v]): [number, number] => [t, change(v, weight(t))]);
  return { ...score, [name]: changed };
}

/** The curve with points added at `times` (values interpolated), in order, without duplicates. */
function withPoints(curve: Curve, times: number[]): Curve {
  const all = new Map<number, number>();
  for (const [t, v] of curve) all.set(t, v);
  for (const t of times) if (!all.has(t)) all.set(t, valueAt(curve, t) as number);
  return [...all.entries()].sort((a, b) => a[0] - b[0]);
}

function meanPitch(score: Score, span: Span): number | undefined {
  if (score.pitch.length === 0) return undefined;
  let sum = 0;
  let count = 0;
  for (let t = span.t0; t <= span.t1; t += STEP) {
    sum += Math.log(valueAt(score.pitch, t) as number);
    count += 1;
  }
  return count > 0 ? Math.exp(sum / count) : undefined;
}

/** `t`, or the end of the sounding phone that `t` falls strictly inside. */
function boundary(score: Score, t: number): number {
  const inside = score.sounds.find((s) => s.sound !== SILENCE && s.t0 < t && t < s.t1);
  return inside ? inside.t1 : t;
}

function whole(score: Score): Span {
  return { t0: 0, t1: score.duration };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** `{ [key]: value }` when the value exists, `{}` otherwise, so that absent fields stay absent. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
