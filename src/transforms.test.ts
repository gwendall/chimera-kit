import { describe, expect, test } from "bun:test";
import type { Score } from "./layers.ts";
import { take } from "./take.ts";
import {
  breathier,
  compose,
  EMPHASIS,
  emphasize,
  gain,
  parseInterval,
  pauseAt,
  RAMP,
  range,
  rate,
  shift,
  stretch,
  tenser,
  valueAt,
} from "./transforms.ts";

/** "hello", said once, with silence around it. */
function hello(): Score {
  return {
    duration: 0.8,
    sounds: [
      { sound: "_", t0: 0, t1: 0.1 },
      { sound: "h", t0: 0.1, t1: 0.2 },
      { sound: "ə", t0: 0.2, t1: 0.3, stress: 0 },
      { sound: "l", t0: 0.3, t1: 0.38 },
      { sound: "oʊ", t0: 0.38, t1: 0.6, stress: 1 },
      { sound: "_", t0: 0.6, t1: 0.8 },
    ],
    pitch: [
      [0, 120],
      [0.3, 140],
      [0.6, 110],
      [0.8, 100],
    ],
    words: [{ text: "Hello,", t0: 0.1, t1: 0.6 }],
  };
}

/** Sounds are in order, touch each other and fill the score. */
function expectContiguous(score: Score) {
  let end = 0;
  for (const s of score.sounds) {
    expect(s.t0).toBeCloseTo(end, 9);
    expect(s.t1).toBeGreaterThan(s.t0);
    end = s.t1;
  }
  expect(end).toBeCloseTo(score.duration, 9);
}

describe("valueAt", () => {
  test("interpolates between points and holds past the ends", () => {
    const { pitch } = hello();
    expect(valueAt(pitch, 0.15)).toBeCloseTo(130, 9);
    expect(valueAt(pitch, -1)).toBe(120);
    expect(valueAt(pitch, 5)).toBe(100);
    expect(valueAt([], 0)).toBeUndefined();
  });
});

describe("stretch", () => {
  test("of the whole score scales every time and leaves the input alone", () => {
    const input = hello();
    const copy = structuredClone(input);
    const out = stretch(2)(input);
    expect(input).toEqual(copy);
    expect(out.duration).toBeCloseTo(1.6, 9);
    expect(out.sounds.map((s) => s.t1)).toEqual(input.sounds.map((s) => s.t1 * 2));
    expect(valueAt(out.pitch, 0.6)).toBeCloseTo(140, 9);
    expectContiguous(out);
  });

  test("of a span moves what follows and keeps what comes before", () => {
    const out = stretch(2)(hello(), { t0: 0.38, t1: 0.6 });
    const vowel = out.sounds[4];
    expect(vowel?.t0).toBeCloseTo(0.38, 9);
    expect(vowel?.t1).toBeCloseTo(0.82, 9);
    expect(out.duration).toBeCloseTo(1.02, 9);
    expect(valueAt(out.pitch, 0.3)).toBeCloseTo(140, 9);
    expect(valueAt(out.pitch, 0.82)).toBeCloseTo(110, 9);
    expect(out.words?.[0]?.t1).toBeCloseTo(0.82, 9);
    expectContiguous(out);
  });

  test("rate is the inverse stretch", () => {
    expect(rate(2)(hello()).duration).toBeCloseTo(0.4, 9);
    expect(() => rate(0)).toThrow("chimera-kit");
  });
});

describe("pitch", () => {
  test("an octave up doubles every value", () => {
    const out = shift("+12st")(hello());
    for (const [t, v] of out.pitch) expect(v).toBeCloseTo(2 * (valueAt(hello().pitch, t) as number), 9);
  });

  test("a scoped shift ramps inside the span and leaves the rest alone", () => {
    const span = { t0: 0.1, t1: 0.6 };
    const out = shift(12)(hello(), span);
    const original = hello().pitch;
    for (const t of [0, 0.05, 0.1, 0.6, 0.7, 0.8]) {
      expect(valueAt(out.pitch, t)).toBeCloseTo(valueAt(original, t) as number, 6);
    }
    const middle = 0.35;
    expect(valueAt(out.pitch, middle)).toBeCloseTo(2 * (valueAt(original, middle) as number), 6);
    const halfway = span.t0 + RAMP / 2;
    const ratio = (valueAt(out.pitch, halfway) as number) / (valueAt(original, halfway) as number);
    expect(ratio).toBeGreaterThan(1.3);
    expect(ratio).toBeLessThan(1.5);
  });

  test("range 0 flattens a span to its mean and range 1 changes nothing", () => {
    const flat = range(0)(hello());
    const values = flat.pitch.map(([, v]) => v);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThan(1e-9);
    const same = range(1)(hello());
    for (const [t, v] of same.pitch) expect(v).toBeCloseTo(valueAt(hello().pitch, t) as number, 9);
  });

  test("intervals parse in semitones and cents", () => {
    expect(parseInterval("+3st")).toBe(3);
    expect(parseInterval("-2.5st")).toBe(-2.5);
    expect(parseInterval("+50c")).toBe(0.5);
    expect(parseInterval(-1)).toBe(-1);
    expect(() => parseInterval("3 semitones")).toThrow("chimera-kit");
  });
});

describe("level and voice quality", () => {
  test("gain and breath create their curve when the score has none", () => {
    const loud = gain(6)(hello());
    expect(valueAt(loud.loudness ?? [], 0.4)).toBeCloseTo(6, 9);
    const airy = breathier(2)(hello());
    expect(valueAt(airy.breath ?? [], 0.4)).toBe(1);
    expect(hello().loudness).toBeUndefined();
  });

  // The bug: a score without a tension curve started from 0, so tenser(0.1) gave 0.1, laxer than
  // the engine's neutral 0.5, and every mood meant to press the voice relaxed it instead.
  test("tenser presses from the neutral 0.5 when the score has no tension, and from its own", () => {
    expect(valueAt(tenser(0.2)(hello()).tension ?? [], 0.4)).toBeCloseTo(0.7, 9);
    expect(valueAt(tenser(-0.2)(hello()).tension ?? [], 0.4)).toBeCloseTo(0.3, 9);
    const own: Score = { ...hello(), tension: [[0, 0.8]] };
    expect(valueAt(tenser(0.1)(own).tension ?? [], 0.4)).toBeCloseTo(0.9, 9);
  });
});

describe("pauseAt", () => {
  test("grows a silence that touches the point", () => {
    const out = pauseAt(0.6, 0.3)(hello());
    expect(out.sounds).toHaveLength(6);
    expect(out.sounds[5]).toEqual({ sound: "_", t0: 0.6, t1: 1.1 });
    expectContiguous(out);
  });

  test("inserts a silence between two phones, and never lengthens a phone", () => {
    const out = pauseAt(0.3, 0.25)(hello());
    expect(out.sounds.map((s) => s.sound)).toEqual(["_", "h", "ə", "_", "l", "oʊ", "_"]);
    expect(out.sounds[2]?.t1).toBeCloseTo(0.3, 9);
    expect(out.sounds[3]).toEqual({ sound: "_", t0: 0.3, t1: 0.55 });
    expect(valueAt(out.pitch, 0.4)).toBeCloseTo(140, 9);
    expectContiguous(out);
  });

  test("inside a phone waits for the end of that phone", () => {
    const out = pauseAt(0.25, 0.1)(hello());
    expect(out.sounds[2]).toEqual({ sound: "ə", t0: 0.2, t1: 0.3, stress: 0 });
    expect(out.sounds[3]).toEqual({ sound: "_", t0: 0.3, t1: 0.4 });
    expectContiguous(out);
  });
});

describe("compose", () => {
  test("moves the scope along with the time changes before each step", () => {
    const span = { t0: 0.38, t1: 0.6 };
    const both = compose(stretch(2), shift(12));
    const out = both(hello(), span);
    // The vowel now ends at 0.82; the octave covers it and stops there.
    expect(valueAt(out.pitch, 0.6)).toBeCloseTo(2 * 121, 6);
    expect(valueAt(out.pitch, 0.9)).toBeCloseTo(valueAt(stretch(2)(hello(), span).pitch, 0.9) as number, 6);
    expect(both.warp?.(0.6, hello(), span)).toBeCloseTo(0.82, 9);
  });

  test("emphasis lengthens, raises and louder a span", () => {
    const span = { t0: 0.1, t1: 0.6 };
    const out = emphasize(1)(hello(), span);
    expect(out.duration).toBeCloseTo(0.8 + 0.5 * EMPHASIS.lengthen, 9);
    expect(valueAt(out.loudness ?? [], 0.3)).toBeCloseTo(EMPHASIS.db, 6);
    expectContiguous(out);
  });
});

describe("take", () => {
  test("selects a word by its text and follows it through edits", () => {
    const t = take(hello());
    const word = t.word("hello").stretch(2).pitch("+3st");
    expect(word.span.t0).toBeCloseTo(0.1, 9);
    expect(word.span.t1).toBeCloseTo(1.1, 9);
    expect(t.score.duration).toBeCloseTo(1.3, 9);
    expectContiguous(t.score);
  });

  test("pauses before and after a word", () => {
    const t = take(hello());
    const word = t.word("Hello").pauseBefore(0.2).pauseAfter(0.1);
    expect(word.span.t0).toBeCloseTo(0.3, 9);
    expect(word.span.t1).toBeCloseTo(0.8, 9);
    expect(t.score.duration).toBeCloseTo(1.1, 9);
    expectContiguous(t.score);
  });

  test("names the words it has when one is missing", () => {
    expect(() => take(hello()).word("goodbye")).toThrow("Words: Hello,");
  });
});
