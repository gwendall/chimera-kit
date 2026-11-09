import { describe, expect, test } from "bun:test";
import { birchCanoeScore } from "./kokoro-fixture.js";
import { encodeSoundsForKokoro } from "./kokoro-phones.js";

describe("birchCanoeScore", () => {
  test("is time-ordered and covers the sentence's 8 words", () => {
    const score = birchCanoeScore();
    expect(score.words?.length).toBe(8);
    let previousEnd = 0;
    for (const sound of score.sounds) {
      expect(sound.t0).toBeGreaterThanOrEqual(previousEnd);
      expect(sound.t1).toBeGreaterThan(sound.t0);
      previousEnd = sound.t1;
    }
    expect(score.duration).toBeGreaterThan(previousEnd - 0.001);
  });

  test("every phone maps cleanly to a Kokoro token: no vocabulary gap", () => {
    const score = birchCanoeScore();
    const { lost } = encodeSoundsForKokoro(score.sounds, score.words);
    const gaps = lost.filter((l) => l.startsWith("vocabulary gap"));
    expect(gaps).toEqual([]);
    expect(lost).not.toContain("word boundaries"); // words were given
  });
});
