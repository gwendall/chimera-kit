import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deliver } from "./delivery.ts";
import { createVoice } from "./index.ts";
import { type AsyncVoice, createWorkerVoice } from "./worker-voice.ts";

const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);
const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);
const TEXT = "The birch canoe slid on the smooth planks.";
const LONG = Array.from({ length: 6 }, () => "Glue the sheet to the dark blue background.").join(" ");

let voice: AsyncVoice;
beforeAll(async () => {
  voice = await createWorkerVoice({
    worker: new Worker(new URL("./worker.ts", import.meta.url)),
    wasm,
    dictionary,
    body: "female",
  });
});
afterAll(() => voice.free());

async function collect(chunks: AsyncIterable<Float32Array>): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("a worker voice", () => {
  test("gives exactly the samples of a voice on this thread", async () => {
    const here = await createVoice({ wasm, dictionary, body: "female" });
    const expected = here.render(TEXT).audio;
    here.free();
    const streamed = await collect(voice.stream(TEXT, { chunkSize: 512 }));
    expect(streamed).toEqual(expected);
    expect((await voice.render(TEXT)).audio).toEqual(expected);
    expect(voice.sampleRate).toBe(48_000);
  });

  test("stops computing a stream the caller leaves", async () => {
    const started = performance.now();
    for await (const _ of voice.stream(LONG)) break;
    // The long utterance takes seconds to compute; the next one must not wait for it.
    const asked = performance.now();
    for await (const _ of voice.stream(TEXT)) break;
    const wait = performance.now() - asked;
    expect(wait).toBeLessThan(250);
    expect(asked - started).toBeLessThan(1000);
  });

  test("speaks a delivery given as data as a voice here speaks its style", async () => {
    // A style is a function and cannot reach a worker; a mood or numbers can, and the worker turns
    // them into the same style. Opened with one, every reading takes it; a call's own replaces it.
    const here = await createVoice({ wasm, dictionary, body: "female" });
    const sad = here.render(TEXT, { style: deliver("sad") }).audio;
    const calm = here.render(TEXT, { style: deliver("calm", 0.5) }).audio;
    here.free();
    const moody = await createWorkerVoice({
      worker: new Worker(new URL("./worker.ts", import.meta.url)),
      wasm,
      dictionary,
      body: "female",
      delivery: "sad",
    });
    try {
      expect((await moody.render(TEXT)).audio).toEqual(sad);
      expect(
        await collect(
          moody.stream(TEXT, {
            delivery: {
              rate: 0.85,
              pitch: -2,
              range: 0.6,
              gain: -4,
              breath: 0.2,
              tension: -0.2,
              pauses: 1.4,
            },
          }),
        ),
      ).toEqual(sad);
      expect((await moody.render(TEXT, { delivery: "calm", intensity: 0.5 })).audio).toEqual(calm);
    } finally {
      moody.free();
    }
    expect(sad).not.toEqual((await voice.render(TEXT)).audio);
  });

  test("passes the engine's errors on", async () => {
    await expect(collect(voice.stream(TEXT, { rate: 100 }))).rejects.toThrow("intone");
    expect((await collect(voice.stream(TEXT))).length).toBeGreaterThan(0);
  });
});
