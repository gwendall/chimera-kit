import { describe, expect, test } from "bun:test";
import { blend, deliver, MOODS } from "./delivery.ts";
import type { Score } from "./layers.ts";
import { take } from "./take.ts";
import { pauses, valueAt } from "./transforms.ts";

/** "hi there", with a silence between the words. */
function hiThere(): Score {
  return {
    duration: 1.1,
    sounds: [
      { sound: "_", t0: 0, t1: 0.1 },
      { sound: "h", t0: 0.1, t1: 0.18 },
      { sound: "aɪ", t0: 0.18, t1: 0.4, stress: 1 },
      { sound: "_", t0: 0.4, t1: 0.6 },
      { sound: "ð", t0: 0.6, t1: 0.66 },
      { sound: "ɛ", t0: 0.66, t1: 0.8, stress: 1 },
      { sound: "ɹ", t0: 0.8, t1: 0.9 },
      { sound: "_", t0: 0.9, t1: 1.1 },
    ],
    pitch: [
      [0, 150],
      [0.4, 180],
      [0.9, 130],
      [1.1, 120],
    ],
    words: [
      { text: "hi", t0: 0.1, t1: 0.4 },
      { text: "there", t0: 0.6, t1: 0.9 },
    ],
  };
}

function meanPitch(score: Score): number {
  let sum = 0;
  let n = 0;
  for (let t = 0; t <= score.duration; t += 0.01, n++) sum += Math.log(valueAt(score.pitch, t) as number);
  return Math.exp(sum / n);
}

describe("pauses", () => {
  test("lengthen the silences between words and leave the edges alone", () => {
    const out = pauses(2)(hiThere());
    expect(out.sounds[3]?.t0).toBeCloseTo(0.4, 9);
    expect(out.sounds[3]?.t1).toBeCloseTo(0.8, 9);
    expect(out.sounds[0]?.t1).toBeCloseTo(0.1, 9);
    const last = out.sounds[7];
    expect((last?.t1 ?? 0) - (last?.t0 ?? 0)).toBeCloseTo(0.2, 9);
    expect(out.duration).toBeCloseTo(1.3, 9);
    expect(out.words?.[1]?.t0).toBeCloseTo(0.8, 9);
  });
});

describe("deliver", () => {
  test("sad is slower, lower, softer and breathier", () => {
    const input = hiThere();
    const out = deliver("sad")(input);
    expect(out.duration).toBeGreaterThan(input.duration / MOODS.sad.rate);
    expect(meanPitch(out)).toBeLessThan(meanPitch(input) * 0.9);
    expect(valueAt(out.loudness ?? [], 0.5)).toBeCloseTo(MOODS.sad.gain, 6);
    expect(valueAt(out.breath ?? [], 0.5)).toBeCloseTo(MOODS.sad.breath, 6);
  });

  test("intensity 0 changes nothing and 2 goes further than 1", () => {
    const input = hiThere();
    const none = deliver("happy", 0)(input);
    expect(none.sounds).toEqual(input.sounds);
    for (let t = 0; t <= 1.1; t += 0.05) {
      expect(valueAt(none.pitch, t)).toBeCloseTo(valueAt(input.pitch, t) as number, 6);
    }
    expect(deliver("tired", 2)(input).duration).toBeGreaterThan(deliver("tired", 1)(input).duration);
  });

  test("on one word leaves the other word alone", () => {
    const t = take(hiThere());
    t.word("there").apply(deliver("angry"));
    expect(t.score.sounds.slice(0, 4)).toEqual(hiThere().sounds.slice(0, 4));
    for (const x of [0.05, 0.2, 0.35]) {
      expect(valueAt(t.score.pitch, x)).toBeCloseTo(valueAt(hiThere().pitch, x) as number, 6);
    }
  });

  test("names the moods it knows when one is missing", () => {
    expect(() => deliver("smug" as "sad")).toThrow("Moods: neutral, happy");
  });
});

describe("blend", () => {
  test("goes from one delivery to another", () => {
    const start = blend("sad", "happy", 0);
    expect(start.rate).toBeCloseTo(MOODS.sad.rate, 9);
    expect(start.pitch).toBeCloseTo(MOODS.sad.pitch, 9);
    const end = blend("sad", "happy", 1);
    expect(end.range).toBeCloseTo(MOODS.happy.range, 9);
    expect(blend({ range: 0 }, { range: 1 }, 0.5).range).toBeCloseTo(0.5, 9);
  });
});
