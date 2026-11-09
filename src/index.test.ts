import { beforeAll, describe, expect, test } from "bun:test";
import { createVoice, type Voice } from "./index.ts";

const wasm = new URL("../dist/chimera_speak.wasm", import.meta.url);
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
    expect(() => voice.render("")).toThrow("chimera-speak");
    expect(() => voice.render(TEXT, { rate: -1 })).toThrow("rate");
    expect(voice.render(TEXT).audio.length).toBeGreaterThan(0);
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
