/**
 * A take: a score being edited. Selections find a word or a span and apply transforms to it; the
 * transforms themselves are pure (see transforms.ts), the take only holds the current score.
 */
import type { Score } from "./layers.js";
import {
  breathier,
  emphasize,
  gain,
  pauseAt,
  range,
  rate,
  type ScoreTransform,
  type Span,
  shift,
  stretch,
  tenser,
} from "./transforms.js";

/** Starts editing a score. The score passed in is never modified. */
export function take(score: Score): Take {
  return new Take(score);
}

export class Take {
  constructor(public score: Score) {}

  /** Applies a transform to the whole score, or to a span. */
  apply(transform: ScoreTransform, scope?: Span): this {
    this.score = transform(this.score, scope);
    return this;
  }

  /** The whole score. */
  all(): Selection {
    return new Selection(this, { t0: 0, t1: this.score.duration });
  }

  /** A span of time, in seconds. */
  span(t0: number, t1: number): Selection {
    if (!(t0 >= 0 && t1 > t0 && t1 <= this.score.duration)) {
      throw new RangeError(
        `chimera-kit: a span must lie inside 0..${this.score.duration} s, got ${t0}..${t1}`,
      );
    }
    return new Selection(this, { t0, t1 });
  }

  /** The `nth` occurrence (from 0) of a word, matched without case or punctuation. */
  word(text: string, nth = 0): Selection {
    const words = this.score.words ?? [];
    const wanted = normalize(text);
    const found = words.filter((w) => normalize(w.text) === wanted)[nth];
    if (!found) {
      const known = words.map((w) => w.text).join(", ") || "none: this score has no word spans";
      throw new RangeError(
        `chimera-kit: no word "${text}" (occurrence ${nth}) in this take. Words: ${known}`,
      );
    }
    return new Selection(this, { t0: found.t0, t1: found.t1 });
  }
}

/** A span of a take. Every edit applies to the take and keeps the span on the same sounds. */
export class Selection {
  constructor(
    readonly take: Take,
    private current: Span,
  ) {}

  /** Where the selection lies now, in seconds. */
  get span(): Span {
    return { ...this.current };
  }

  apply(transform: ScoreTransform): this {
    const before = this.take.score;
    const within = this.current;
    this.take.apply(transform, within);
    const { warp } = transform;
    if (warp) this.current = { t0: warp(within.t0, before, within), t1: warp(within.t1, before, within) };
    return this;
  }

  /** Makes the span `factor` times as long. */
  stretch(factor: number): this {
    return this.apply(stretch(factor));
  }

  /** Speaks the span `r` times as fast. */
  rate(r: number): this {
    return this.apply(rate(r));
  }

  /** Raises the pitch: `"+3st"`, `"-50c"`, or a number of semitones. */
  pitch(interval: number | string): this {
    return this.apply(shift(interval));
  }

  /** Scales the pitch excursions (0 is a monotone). */
  range(factor: number): this {
    return this.apply(range(factor));
  }

  gain(db: number): this {
    return this.apply(gain(db));
  }

  breathier(amount: number): this {
    return this.apply(breathier(amount));
  }

  tenser(amount: number): this {
    return this.apply(tenser(amount));
  }

  emphasize(amount = 1): this {
    return this.apply(emphasize(amount));
  }

  /** Silence before the span; the span moves later with it. */
  pauseBefore(seconds: number): this {
    const { t0, t1 } = this.current;
    const before = this.take.score;
    const pause = pauseAt(t0, seconds);
    this.take.apply(pause);
    const move = (t: number) => pause.warp?.(t, before) ?? t;
    const startsASound = before.sounds.some((s) => s.t0 === t0);
    this.current = { t0: startsASound ? t0 + seconds : move(t0), t1: move(t1) };
    return this;
  }

  /** Silence after the span. */
  pauseAfter(seconds: number): this {
    this.take.apply(pauseAt(this.current.t1, seconds));
    return this;
  }
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
}
