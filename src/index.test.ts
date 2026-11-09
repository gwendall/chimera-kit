import { beforeAll, describe, expect, test } from "bun:test";
import { createVoice, deliver, type Voice } from "./index.ts";

const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);
const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);
const TEXT = "Hello there.";

function rms(audio: Float32Array): number {
  return Math.sqrt(audio.reduce((sum, x) => sum + x * x, 0) / audio.length);
}

describe("a voice", () => {
  let voice: Voice;

  beforeAll(async () => {
    voice = await createVoice({ wasm, dictionary });
  });

  test("renders audible, bounded audio", () => {
    const { audio, sampleRate } = voice.render(TEXT);
    expect(sampleRate).toBe(48_000);
    expect(audio.length / sampleRate).toBeGreaterThan(0.3);
    expect(rms(audio)).toBeGreaterThan(0.001);
    expect(audio.every((x) => Number.isFinite(x) && Math.abs(x) < 4)).toBe(true);
  });

  test("streams the same samples as it renders", () => {
    const whole = voice.render(TEXT).audio;
    const chunks = [...voice.stream(TEXT)];
    expect(chunks.length).toBeGreaterThan(1);
    const joined = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    expect(joined as Float32Array).toEqual(whole);
  });

  test("streams in the requested chunk size, 128 samples by default", () => {
    expect(voice.stream(TEXT).next().value?.length).toBe(128);
    const chunks = [...voice.stream(TEXT, { chunkSize: 1000 })];
    expect(chunks[0]?.length).toBe(1000);
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBe(voice.render(TEXT).audio.length);
  });

  test("refuses a chunk size the engine can't honor", () => {
    for (const chunkSize of [0, 4097, 1.5]) {
      expect(() => voice.stream(TEXT, { chunkSize }).next()).toThrow("chunkSize");
    }
  });

  test("is deterministic", () => {
    expect(voice.render(TEXT).audio).toEqual(voice.render(TEXT).audio);
  });

  test("a faster rate is shorter", () => {
    expect(voice.render(TEXT, { rate: 1.5 }).audio.length).toBeLessThan(voice.render(TEXT).audio.length);
  });

  test("reports bad requests with a message and keeps working", () => {
    expect(() => voice.render("")).toThrow("intone");
    expect(() => voice.render(TEXT, { rate: -1 })).toThrow("rate");
    expect(voice.render(TEXT).audio.length).toBeGreaterThan(0);
  });
});

describe("a score", () => {
  let voice: Voice;

  beforeAll(async () => {
    voice = await createVoice({ wasm, dictionary });
  });

  test("plans text into a score whose sounds cover its duration", () => {
    const score = voice.plan(TEXT);
    expect(score.duration).toBeGreaterThan(0);
    expect(score.sounds.length).toBeGreaterThan(0);
    expect(score.pitch.length).toBeGreaterThan(0);
    let end = 0;
    for (const s of score.sounds) {
      expect(s.t0).toBeGreaterThanOrEqual(end - 1e-9);
      expect(s.t1).toBeGreaterThan(s.t0);
      end = s.t1;
    }
    expect(end).toBeCloseTo(score.duration, 5);
  });

  test("renders a planned score back, honoring its own duration", () => {
    const score = voice.plan(TEXT);
    const { audio, sampleRate } = voice.render(score);
    expect(audio.length / sampleRate).toBeCloseTo(score.duration, 1);
    expect(audio.every((x) => Number.isFinite(x) && Math.abs(x) < 4)).toBe(true);
    expect(rms(audio)).toBeGreaterThan(0.001);
  });

  test("streams a score the same way it streams text", () => {
    const score = voice.plan(TEXT);
    const whole = voice.render(score).audio;
    const chunks = [...voice.stream(score)];
    expect(chunks.length).toBeGreaterThan(1);
    const joined = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    expect(joined as Float32Array).toEqual(whole);
  });

  test("reports a bad score with a readable, prefixed message", () => {
    const score = voice.plan(TEXT);
    expect(() => voice.render({ ...score, duration: -1 })).toThrow("intone");
    expect(() => voice.render({ ...score, duration: -1 })).toThrow("duration");
    expect(() => voice.render({ ...score, sounds: [] })).toThrow("sounds");
  });

  test("a style shapes text as it shapes the score planned from it", () => {
    const sad = deliver("sad");
    const shaped = sad(voice.plan(TEXT));
    expect(voice.plan(TEXT, { style: sad })).toEqual(shaped);
    const { audio } = voice.render(TEXT, { style: sad });
    expect(audio).toEqual(voice.render(shaped).audio);
    expect(audio.length).toBeGreaterThan(voice.render(TEXT).audio.length);
    expect(voice.render(voice.plan(TEXT), { style: sad }).audio).toEqual(audio);
  });

  test("a voice's style is in its plans, and not applied a second time to them", async () => {
    const sad = await createVoice({ wasm, dictionary, style: deliver("sad") });
    try {
      const { audio } = sad.render(TEXT);
      expect(audio).toEqual(sad.render(sad.plan(TEXT)).audio);
      expect(audio).toEqual(voice.render(TEXT, { style: deliver("sad") }).audio);
      const chunks = [...sad.stream(TEXT, { chunkSize: 4096 })];
      expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBe(audio.length);
    } finally {
      sad.free();
    }
  });

  test("refuses timing and pitch options, which a score already holds", () => {
    const score = voice.plan(TEXT);
    expect(() => voice.render(score, { rate: 1.5 })).toThrow("stretch");
    expect(() => voice.render(score, { f0: 200, accent: 0.3 })).toThrow("f0, accent");
    expect(voice.render(score, { body: "female" }).audio.length).toBeGreaterThan(0);
  });

  test("a tension curve that changes over time is refused", () => {
    const score = voice.plan(TEXT);
    const tension: [number, number][] = [
      [0, 0.2],
      [score.duration, 0.8],
    ];
    expect(() => voice.render({ ...score, tension })).toThrow("tension");
  });
});

describe("createVoice", () => {
  test("applies the options given at creation", async () => {
    const fast = await createVoice({ wasm, dictionary: false, rate: 1.5 });
    const normal = await createVoice({ wasm, dictionary: false });
    expect(fast.render(TEXT).audio.length).toBeLessThan(normal.render(TEXT).audio.length);
    expect(fast.render(TEXT, { rate: 1 }).audio).toEqual(normal.render(TEXT).audio);
  });

  test("the dictionary changes irregular words", async () => {
    const rules = await createVoice({ wasm, dictionary: false });
    const known = await createVoice({ wasm, dictionary });
    expect(known.render("colonel").audio).not.toEqual(rules.render("colonel").audio);
  });

  test("a freed voice refuses to speak and can be freed twice", async () => {
    const voice = await createVoice({ wasm, dictionary: false });
    voice.free();
    voice.free();
    expect(() => voice.render(TEXT)).toThrow("freed");
  });
});
