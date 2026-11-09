import { describe, expect, test } from "bun:test";
import type { Engine, EngineRequest } from "./engine.ts";
import { voiceFrom } from "./voice.ts";

/** An engine with nothing of CHIMERA in it: if this works, the voice doesn't depend on CHIMERA. */
function fakeEngine(samples = 300) {
  const log = { requests: [] as EngineRequest[], freedUtterances: 0, freedEngines: 0 };
  const engine: Engine = {
    sampleRate: 8000,
    maxChunk: 100,
    begin(request) {
      if (request.text === "") throw new Error("nothing to say");
      log.requests.push(request);
      let at = 0;
      return {
        samples,
        next(max) {
          const n = Math.min(max, samples - at);
          if (n === 0) return null;
          const chunk = Float32Array.from({ length: n }, (_, i) => at + i);
          at += n;
          return chunk;
        },
        free() {
          log.freedUtterances++;
        },
      };
    },
    free() {
      log.freedEngines++;
    },
  };
  return { engine, log };
}

describe("a voice over any engine", () => {
  test("renders everything the engine gives, in chunks it can honor", () => {
    const { engine, log } = fakeEngine();
    const { audio, sampleRate } = voiceFrom(engine).render("hi");
    expect(sampleRate).toBe(8000);
    expect(audio.length).toBe(300);
    expect(audio[299]).toBe(299);
    expect(log.freedUtterances).toBe(1);
  });

  test("options override the defaults and reach the engine", () => {
    const { engine, log } = fakeEngine();
    voiceFrom(engine, { rate: 2, f0: 100 }).render("hi", { f0: 150 });
    expect(log.requests).toEqual([{ rate: 2, f0: 150, text: "hi" }]);
  });

  test("text without a style reaches the engine as text; with one, it needs an engine that renders scores", () => {
    const { engine, log } = fakeEngine();
    const voice = voiceFrom(engine, { rate: 1.2 });
    voice.render("hi");
    expect(log.requests).toEqual([{ rate: 1.2, text: "hi" }]);
    expect(() => voice.render("hi", { style: (score) => score })).toThrow("cannot render a score");
  });

  test("chunkSize stays out of the engine's request", () => {
    const { engine, log } = fakeEngine();
    [...voiceFrom(engine).stream("hi", { chunkSize: 50, rate: 2 })];
    expect(log.requests).toEqual([{ rate: 2, text: "hi" }]);
  });

  test("airway reports once per chunk, and is skipped by an engine without one", () => {
    const { engine } = fakeEngine();
    const seen: Float32Array[] = [];
    const chunks = [...voiceFrom(engine).stream("hi", { chunkSize: 50, airway: (s) => seen.push(s) })];
    expect(chunks.length).toBeGreaterThan(0);
    expect(seen.length).toBe(0);

    const state = new Float32Array([1, 2, 3]);
    const begin = engine.begin.bind(engine);
    engine.begin = (request) => Object.assign(begin(request), { airway: () => state });
    const counted: Float32Array[] = [];
    const again = [...voiceFrom(engine).stream("hi", { chunkSize: 50, airway: (s) => counted.push(s) })];
    expect(counted.length).toBe(again.length);
    expect(counted[0]).toBe(state);
  });

  test("a stream abandoned early still frees its utterance", () => {
    const { engine, log } = fakeEngine();
    for (const _ of voiceFrom(engine).stream("hi", { chunkSize: 10 })) break;
    expect(log.freedUtterances).toBe(1);
  });

  test("refuses a chunk larger than the engine's", () => {
    const { engine } = fakeEngine();
    expect(() => voiceFrom(engine).stream("hi", { chunkSize: 101 }).next()).toThrow("chunkSize");
  });

  test("freeing twice frees the engine once", () => {
    const { engine, log } = fakeEngine();
    const voice = voiceFrom(engine);
    voice.free();
    voice.free();
    expect(log.freedEngines).toBe(1);
    expect(() => voice.render("hi")).toThrow("freed");
  });
});
