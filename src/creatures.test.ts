import { beforeAll, describe, expect, test } from "bun:test";
import { type Creatures, loadCreatures } from "./creatures.ts";

const wasm = new URL("../dist/intone_creatures.wasm", import.meta.url);

describe("loadCreatures", () => {
  let zoo: Creatures;

  beforeAll(async () => {
    zoo = await loadCreatures({ wasm });
  });

  test("the catalog has the 4 creatures", () => {
    expect(zoo.sampleRate).toBe(48_000);
    expect(zoo.list.map((c) => c.id).sort()).toEqual(["alligator", "elephant", "seal", "songbird"]);
    for (const creature of zoo.list) {
      expect(creature.params.length).toBeGreaterThan(0);
      expect(creature.calls.length).toBeGreaterThan(0);
    }
  });

  test("unknown creature ids throw, naming the known ones", () => {
    expect(() => zoo.create("dragon")).toThrow(/intone: no creature 'dragon'.*songbird/s);
  });

  describe("a creature", () => {
    test("unknown call ids throw, naming the known ones", () => {
      const bird = zoo.create("songbird");
      expect(() => bird.call("roar")).toThrow(/intone: songbird has no call 'roar'.*flute/s);
      bird.free();
    });

    // Each comparison below uses a *fresh* creature per call: two calls played back to back on
    // the same instance are not bit-identical (the second starts from whatever the first left
    // the airway in, even once it is audibly quiet), so determinism is about repeatable fresh
    // state, not about reusing one instance.
    test("call is deterministic and has the expected length", () => {
      const a = zoo.create("songbird");
      const b = zoo.create("songbird");
      const call = a.info.calls.find((c) => c.id === "flute");
      if (!call) throw new Error("flute call missing from the catalog");
      const lastKeyT = call.keys[call.keys.length - 1]?.t ?? 0;
      const minSamples = Math.ceil((lastKeyT + 0.05) * zoo.sampleRate);
      const maxSamples = minSamples + Math.round(zoo.sampleRate * 2);

      const out1 = a.call("flute");
      const out2 = b.call("flute");
      expect(out1).toEqual(out2);
      expect(out1.length).toBeGreaterThanOrEqual(minSamples);
      expect(out1.length).toBeLessThanOrEqual(maxSamples);
      expect(out1.every((x) => Number.isFinite(x))).toBe(true);
      expect(out1.some((x) => Math.abs(x) > 1e-4)).toBe(true);
      a.free();
      b.free();
    });

    test("stream gives the same samples as call, just chunked", () => {
      const a = zoo.create("songbird");
      const b = zoo.create("songbird");
      const whole = a.call("trill");
      const chunks: Float32Array[] = [];
      for (const chunk of b.stream("trill", { chunkSize: 500 })) chunks.push(chunk);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const joined = new Float32Array(total);
      let at = 0;
      for (const c of chunks) {
        joined.set(c, at);
        at += c.length;
      }
      expect(joined as Float32Array).toEqual(whole);
      expect(chunks.slice(0, -1).every((c) => c.length === 500)).toBe(true);
      a.free();
      b.free();
    });

    test("stream computes as it is read, so freeing mid-call stops it cleanly", () => {
      const bird = zoo.create("songbird");
      const chunks = bird.stream("trill", { chunkSize: 256 });
      expect(chunks.next().value?.length).toBe(256);
      bird.free();
      expect(() => chunks.next()).toThrow("has been freed");
    });

    test("a freed creature refuses every use, and a second free is harmless", () => {
      const bird = zoo.create("songbird");
      bird.free();
      bird.free();
      const refused = "has been freed";
      expect(() => bird.render(128)).toThrow(refused);
      expect(() => bird.call("trill")).toThrow(refused);
      expect(() => bird.gate(1)).toThrow(refused);
      expect(() => bird.stop()).toThrow(refused);
      expect(() => bird.set({})).toThrow(refused);
    });

    test("an unknown parameter is an error that names the known ones", () => {
      const bird = zoo.create("songbird");
      const known = bird.info.params[0]?.key ?? "";
      expect(() => bird.set({ nope: 1 })).toThrow(known);
      bird.free();
    });

    test("a non-finite control is refused before it reaches the simulation", () => {
      const bird = zoo.create("songbird");
      const key = bird.info.params[0]?.key ?? "";
      expect(() => bird.set({ [key]: Number.NaN })).toThrow(RangeError);
      expect(() => bird.gate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
      expect(() => bird.call("trill", { amp: Number.NaN })).toThrow(RangeError);
      expect(() => [...bird.stream("trill", { chunkSize: 0 })]).toThrow(RangeError);
      bird.free();
    });

    test("render gives continuous, bounded audio at an arbitrary length", () => {
      const bird = zoo.create("songbird");
      bird.gate(1);
      const out = bird.render(10_000);
      expect(out.length).toBe(10_000);
      expect(out.every((x) => Number.isFinite(x) && Math.abs(x) <= 1.5)).toBe(true);
      bird.gate(0);
      bird.free();
    });
  });
});
