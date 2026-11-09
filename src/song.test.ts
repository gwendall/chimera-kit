import { describe, expect, test } from "bun:test";
import { isSong, refuseTiming, spokenLyrics, unsung } from "./song.ts";

const twinkle = { lyrics: "Twin-kle twin-kle lit-tle star", notes: [], bpm: 100 };

describe("a song for a backend that cannot sing", () => {
  test("its lyrics read as words: syllables joined, held notes dropped", () => {
    expect(spokenLyrics(twinkle)).toBe("Twinkle twinkle little star");
    expect(spokenLyrics({ ...twinkle, lyrics: "  Ah - ~ and well-known , friend ~" })).toBe(
      "Ah and wellknown , friend",
    );
  });

  test("loses its notes, and its vibrato and t0 when it has them", () => {
    expect(unsung(twinkle)).toEqual(["notes"]);
    expect(unsung({ ...twinkle, vibrato: 0 })).toEqual(["notes"]);
    expect(unsung({ ...twinkle, vibrato: 40, t0: 0.5 })).toEqual(["notes", "vibrato", "t0"]);
  });

  test("is told from text and pieces of text", () => {
    expect(isSong(twinkle)).toBe(true);
    expect(isSong("la la")).toBe(false);
    expect(isSong(["la", "la"])).toBe(false);
    expect(isSong(null)).toBe(false);
  });

  test("refuses the timing its notes set, on every backend alike", () => {
    expect(() => refuseTiming("a song", { rate: 1.2, accent: 0.5 })).toThrow(
      "intone: a song ignores rate, accent; transform it instead",
    );
    expect(() => refuseTiming("a song", { body: "male" } as never)).not.toThrow();
    expect(() => refuseTiming("a song")).not.toThrow();
  });
});
