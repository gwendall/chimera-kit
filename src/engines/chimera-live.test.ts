import { afterEach, describe, expect, test } from "bun:test";
import { type ChimeraLiveEngine, loadLiveEngine } from "./chimera-live.ts";

const wasm = new URL("../../dist/chimera.wasm", import.meta.url);
const SAMPLE_RATE = 48_000;

let engine: ChimeraLiveEngine | undefined;
afterEach(() => {
  engine?.free();
  engine = undefined;
});

function renderAll(e: ChimeraLiveEngine, n: number, chunk = 4096): Float32Array {
  const out = new Float32Array(n);
  let at = 0;
  while (at < n) {
    const got = e.render(Math.min(chunk, n - at));
    out.set(got, at);
    at += got.length;
  }
  return out;
}

describe("ChimeraLiveEngine", () => {
  test("a held note is audible within a few milliseconds and finite", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    engine.setBody("female");
    engine.noteOn(60);
    engine.vowel("a");
    const out = renderAll(engine, Math.round(SAMPLE_RATE * 0.1));
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
    const first = out.findIndex((x) => Math.abs(x) > 1e-3);
    expect(first).toBeGreaterThanOrEqual(0);
    expect((first / SAMPLE_RATE) * 1000).toBeLessThan(30);
  });

  test("note off quiets the voice", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    engine.noteOn(64);
    engine.vowel("a");
    renderAll(engine, Math.round(SAMPLE_RATE * 0.05)); // let it speak up
    engine.noteOff();
    const tail = renderAll(engine, Math.round(SAMPLE_RATE * 0.5));
    const released = tail.slice(tail.length - 4096);
    const peak = released.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeLessThan(0.01);
  });

  test("changing the vowel changes the sound", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    engine.noteOn(60);
    engine.vowel("a");
    renderAll(engine, 8192); // settle
    const a = renderAll(engine, 8192);
    engine.vowel("i");
    renderAll(engine, 8192); // settle
    const i = renderAll(engine, 8192);
    expect(a).not.toEqual(i);
  });

  test("bend glides pitch without retriggering the gate", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    engine.noteOn(60);
    engine.vowel("a");
    renderAll(engine, 4096);
    engine.bend(67);
    const out = renderAll(engine, 4096);
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
  });

  test("invalid input is rejected and leaves the engine usable", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);

    expect(() => engine?.vowel("zz")).toThrow("unknown vowel");
    expect(() => engine?.noteOn(Number.NaN)).toThrow("finite");
    expect(() => engine?.bend(Number.NaN)).toThrow("finite");
    // Client-side: JSON cannot carry NaN (JSON.stringify(NaN) is "null"), so these are caught
    // before encoding, not by the wasm side's own (unreachable) finiteness check.
    expect(() => engine?.shape({ jaw: Number.NaN })).toThrow("finite");
    expect(() => engine?.source({ f0: Number.POSITIVE_INFINITY })).toThrow("finite");
    expect(() => engine?.beatHit({ id: "nope" })).toThrow("unknown beat sound");

    engine.noteOn(60);
    engine.vowel("a");
    const out = renderAll(engine, 8192);
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
    const peak = out.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeGreaterThan(0.01);
  });

  test("rapid noteOn/noteOff renders finite samples", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    engine.vowel("a");
    for (let i = 0; i < 50; i++) {
      engine.noteOn(60 + (i % 5));
      expect(renderAll(engine, 256).every((x) => Number.isFinite(x))).toBe(true);
      engine.noteOff();
      expect(renderAll(engine, 256).every((x) => Number.isFinite(x))).toBe(true);
    }
  });

  test("freeing a sounding voice does not throw", async () => {
    const e = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    e.noteOn(60);
    e.vowel("a");
    renderAll(e, 4096);
    expect(() => e.free()).not.toThrow();
  });

  test("render always returns the requested length, capped at maxChunk", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    expect(engine.render(400)).toHaveLength(400);
    expect(engine.render(engine.maxChunk + 1000)).toHaveLength(engine.maxChunk);
  });

  test("telemetry's header matches its arrays, and the beatbox ticks", async () => {
    engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    const pattern = "kick . snare .";
    engine.beatSteps(pattern);
    engine.beatTempo({ bpm: 240 });
    engine.beatPlaying(true);
    const steps = new Set<number>();
    for (let i = 0; i < 200; i++) {
      renderAll(engine, 512);
      const t = engine.telemetry();
      for (const arr of [
        t.artic,
        t.pharynxAreas,
        t.mouthAreas,
        t.pressureRms,
        t.flow,
        t.glottalArea,
        t.glottalFlow,
      ]) {
        expect(arr.every((x) => Number.isFinite(x))).toBe(true);
      }
      steps.add(t.beatStep);
    }
    expect(steps.size).toBeGreaterThan(1);
    engine.beatPlaying(false);
  });

  test("beat steps by name sound the same as by pattern symbol", async () => {
    const byName = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    byName.beatSteps("kick . snare .");
    byName.beatTempo({ bpm: 600 });
    byName.beatPlaying(true);
    const a = renderAll(byName, Math.round(SAMPLE_RATE * 0.2));
    byName.free();

    const bySymbol = await loadLiveEngine({ wasm }, SAMPLE_RATE);
    bySymbol.beatSteps("B . Pf .");
    bySymbol.beatTempo({ bpm: 600 });
    bySymbol.beatPlaying(true);
    const b = renderAll(bySymbol, Math.round(SAMPLE_RATE * 0.2));
    bySymbol.free();

    expect(a).toEqual(b);
  });

  // Chromium's AudioWorkletGlobalScope has neither global, so every JSON-encoded setter and
  // `vowel`/`beatSteps` used to throw there and be silently swallowed (the worklet's own
  // try/catch posts an error nobody read): a held note still sounded (from `noteOn`'s default
  // state), masking that `vowel`, `shape`, `source` and the whole beatbox never actually applied.
  test("still works with no TextEncoder/TextDecoder in scope", async () => {
    const realEncoder = globalThis.TextEncoder;
    const realDecoder = globalThis.TextDecoder;
    // @ts-expect-error -- simulating a global scope that has neither, on purpose.
    delete globalThis.TextEncoder;
    // @ts-expect-error
    delete globalThis.TextDecoder;
    try {
      engine = await loadLiveEngine({ wasm }, SAMPLE_RATE);
      engine.setBody("female");
      engine.noteOn(60);
      engine.vowel("a");
      engine.beatSteps("kick . snare .");
      engine.beatTempo({ bpm: 240 });
      engine.beatPlaying(true);
      const out = renderAll(engine, Math.round(SAMPLE_RATE * 0.4));
      expect(out.every((x) => Number.isFinite(x))).toBe(true);
      const peak = out.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      expect(peak).toBeGreaterThan(0.1);
      expect(() => engine?.vowel("ɑ")).not.toThrow();
      expect(() => engine?.beatHit({ id: "nope" })).toThrow("unknown beat sound");
    } finally {
      globalThis.TextEncoder = realEncoder;
      globalThis.TextDecoder = realDecoder;
    }
  });
});
