import { describe, expect, test } from "bun:test";
import { bodyFromSeed } from "./bodies.ts";
import { createVoice } from "./index.ts";

const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);

describe("bodyFromSeed", () => {
  test("gives the same body for the same seed, numbers and strings alike", () => {
    expect(bodyFromSeed(7)).toEqual(bodyFromSeed(7));
    expect(bodyFromSeed("ada")).toEqual(bodyFromSeed("ada"));
    expect(bodyFromSeed("ada")).not.toEqual(bodyFromSeed("bob"));
  });

  // A promise to callers who store a seed for a user: changing the drawing changes their voice.
  test("keeps seed 1's body from one version to the next", () => {
    expect(bodyFromSeed(1)).toEqual({
      female: 0.701,
      child: 0,
      size: 1.038,
      throat: 1.047,
      tongue: 0.974,
      lips: 1.023,
      pitch: 0.754,
      breathiness: 0.113,
      tension: 0.648,
      brightness: 0.287,
      fry: 0,
      roughness: 0.054,
    });
  });

  test("gives a different body for every seed, inside the drawn region", () => {
    const bodies = Array.from({ length: 2000 }, (_, i) => bodyFromSeed(i));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(bodies.length);
    for (const b of bodies) {
      const female = b.female ?? 0;
      expect(female <= 0.3 || female >= 0.7).toBe(true);
      expect(b.child === 0 || ((b.child ?? 0) >= 0.4 && (b.child ?? 0) <= 1)).toBe(true);
      for (const key of ["size", "throat", "tongue", "lips"] as const) {
        expect(b[key]).toBeGreaterThanOrEqual(0.9);
        expect(b[key]).toBeLessThanOrEqual(1.1);
      }
      expect(Math.abs(b.pitch ?? 0)).toBeLessThanOrEqual(3.6);
      for (const key of ["breathiness", "tension", "brightness", "fry", "roughness"] as const) {
        expect(b[key]).toBeGreaterThanOrEqual(0);
        expect(b[key]).toBeLessThanOrEqual(0.65);
      }
    }
    const share = (f: (b: (typeof bodies)[number]) => boolean) => bodies.filter(f).length / bodies.length;
    expect(share((b) => (b.female ?? 0) >= 0.7)).toBeCloseTo(0.5, 1);
    expect(share((b) => (b.child ?? 0) > 0)).toBeCloseTo(0.15, 1);
  });

  test("refuses a seed that isn't a finite number or a string", () => {
    expect(() => bodyFromSeed(Number.NaN)).toThrow("seed");
    expect(() => bodyFromSeed(Number.POSITIVE_INFINITY)).toThrow("seed");
  });

  test("every drawn body speaks, audibly and within range", async () => {
    const voice = await createVoice({ wasm, dictionary: false });
    try {
      for (let seed = 0; seed < 24; seed++) {
        const { audio } = voice.render("Hello there.", { body: bodyFromSeed(seed) });
        let peak = 0;
        for (const x of audio) {
          expect(Number.isFinite(x)).toBe(true);
          peak = Math.max(peak, Math.abs(x));
        }
        expect(peak).toBeGreaterThan(0.01);
        expect(peak).toBeLessThanOrEqual(1);
      }
    } finally {
      voice.free();
    }
  });
});
