import { describe, expect, test } from "bun:test";
import { isSong, refuseTiming } from "./song.ts";

const twinkle = { lyrics: "Twin-kle twin-kle lit-tle star", notes: [], bpm: 100 };

describe("song input and timing", () => {
  test("is told from text and pieces of text", () => {
    expect(isSong(twinkle)).toBe(true);
    expect(isSong("la la")).toBe(false);
    expect(isSong(["la", "la"])).toBe(false);
    expect(isSong(null)).toBe(false);
  });

  test("refuses the timing its notes already set", () => {
    expect(() => refuseTiming("a song", { rate: 1.2, accent: 0.5 })).toThrow(
      "chimera-kit: a song ignores rate, accent; transform it instead",
    );
    expect(() => refuseTiming("a song", { body: "male" } as never)).not.toThrow();
    expect(() => refuseTiming("a song")).not.toThrow();
  });
});
