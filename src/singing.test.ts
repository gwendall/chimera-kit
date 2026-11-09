import { describe, expect, test } from "bun:test";
import { createVoice } from "./index.ts";
import type { Score, Song } from "./layers.ts";
import { fall, harmony, keyOf, melody, scoop } from "./singing.ts";
import { compose, valueAt } from "./transforms.ts";

/** "sun, on": a vowel at 0.1 to 0.5, a coda, a silence, then a held vowel to the end. */
function line(): Score {
  return {
    duration: 2,
    sounds: [
      { sound: "s", t0: 0, t1: 0.1 },
      { sound: "ʌ", t0: 0.1, t1: 0.5 },
      { sound: "n", t0: 0.5, t1: 0.6 },
      { sound: "_", t0: 0.6, t1: 0.8 },
      { sound: "ɑ", t0: 0.8, t1: 1.4 },
      { sound: "ɑ", t0: 1.4, t1: 2 },
    ],
    pitch: [
      [0, 200],
      [2, 200],
    ],
  };
}

/** How far the curve is from 200 Hz at `t`, in semitones. */
function offset(score: Score, t: number): number {
  return 12 * Math.log2((valueAt(score.pitch, t) as number) / 200);
}

describe("scoop", () => {
  test("starts a syllable's vowel below the note and reaches it", () => {
    const scooped = scoop(2, 0.1)(line());
    expect(offset(scooped, 0.1)).toBeCloseTo(-2, 5);
    expect(offset(scooped, 0.15)).toBeCloseTo(-0.5, 1);
    expect(offset(scooped, 0.2)).toBeCloseTo(0, 5);
    expect(offset(scooped, 0.05)).toBeCloseTo(0, 5);
  });

  test("a held note continues its vowel, with no new attack", () => {
    const scooped = scoop(2, 0.1)(line());
    expect(offset(scooped, 0.8)).toBeCloseTo(-2, 5);
    expect(offset(scooped, 1.4)).toBeCloseTo(0, 5);
  });

  test("takes at most half of a short vowel", () => {
    const short: Score = {
      duration: 0.2,
      sounds: [{ sound: "i", t0: 0, t1: 0.1 }],
      pitch: [
        [0, 200],
        [0.2, 200],
      ],
    };
    const scooped = scoop(2, 1)(short);
    expect(offset(scooped, 0)).toBeCloseTo(-2, 5);
    expect(offset(scooped, 0.05)).toBeCloseTo(0, 5);
  });

  test("a scope limits it to the vowels that start inside", () => {
    const scooped = scoop(2, 0.1)(line(), { t0: 0.7, t1: 1 });
    expect(offset(scooped, 0.1)).toBeCloseTo(0, 5);
    expect(offset(scooped, 0.8)).toBeCloseTo(-2, 5);
  });
});

describe("fall", () => {
  test("drops off the last vowel of each phrase, and stays down through the coda", () => {
    const fallen = fall(4, 0.2)(line());
    expect(offset(fallen, 0.29)).toBeCloseTo(0, 5);
    expect(offset(fallen, 0.4)).toBeCloseTo(-1, 1);
    expect(offset(fallen, 0.5)).toBeCloseTo(-4, 5);
    expect(offset(fallen, 0.59)).toBeCloseTo(-4, 5);
  });

  test("leaves the silence after the phrase and the next phrase's start alone", () => {
    const fallen = fall(4, 0.2)(line());
    expect(offset(fallen, 0.7)).toBeCloseTo(0, 5);
    expect(offset(fallen, 0.9)).toBeCloseTo(0, 5);
  });

  test("the last phrase ends at the score's end, without a silence", () => {
    const fallen = fall(4, 0.2)(line());
    expect(offset(fallen, 2)).toBeCloseTo(-4, 5);
    expect(offset(fallen, 1.7)).toBeCloseTo(0, 5);
  });

  test("a scope limits it to the vowels that end inside", () => {
    const fallen = fall(4, 0.2)(line(), { t0: 1.5, t1: 2 });
    expect(offset(fallen, 0.5)).toBeCloseTo(0, 5);
    expect(offset(fallen, 2)).toBeCloseTo(-4, 5);
  });
});

describe("both", () => {
  for (const [name, make] of [
    ["scoop", scoop],
    ["fall", fall],
  ] as const) {
    test(`${name} changes only the pitch, never the input, and keeps the curve in order`, () => {
      const score = line();
      const before = structuredClone(score);
      const after = make()(score);
      expect(score).toEqual(before);
      expect({ ...after, pitch: [] }).toEqual({ ...before, pitch: [] });
      for (let i = 1; i < after.pitch.length; i += 1) {
        expect((after.pitch[i] as [number, number])[0]).toBeGreaterThan(
          (after.pitch[i - 1] as [number, number])[0],
        );
      }
    });

    test(`${name} refuses a depth or a length that is not above zero`, () => {
      expect(() => make(0)).toThrow(/depth/);
      expect(() => make(Number.NaN)).toThrow(/depth/);
      expect(() => make(1, 0)).toThrow(/length/);
      expect(() => make(1, Number.POSITIVE_INFINITY)).toThrow(/length/);
    });

    test(`${name} leaves a score with no pitch alone`, () => {
      const empty = { ...line(), pitch: [] };
      expect(make()(empty)).toBe(empty);
    });
  }
});

describe("the singing entry", () => {
  test("carries the melody, harmony and key helpers", () => {
    const notes = melody("E4 G4 C4:2");
    expect(keyOf(notes)).toBe("C");
    const song: Song = { lyrics: "la la la", notes, bpm: 100 };
    expect(harmony(song, "octave-below").notes[2]?.midi).toBe(48);
  });

  test("the real engine sings a styled song, for the same length and with a different sound", async () => {
    const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);
    const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);
    const voice = await createVoice({ wasm, dictionary });
    const song: Song = {
      lyrics: "sun-light on the wa-ter ~",
      notes: melody("C4:1 D4:1 E4:1 G4:1 A4:1 G4:1 C4:2"),
      bpm: 120,
    };
    const plain = voice.render(song);
    const styled = voice.render(song, { style: compose(scoop(), fall()) });
    expect(styled.audio.length).toBe(plain.audio.length);
    expect(styled.audio.some((sample, i) => sample !== plain.audio[i])).toBe(true);
    voice.free();
  });
});
