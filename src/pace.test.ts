import { beforeAll, describe, expect, test } from "bun:test";
import { createVoice, type Voice } from "./index.ts";
import { pauseAfter, speech, withPause } from "./pace.ts";

const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);
const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);

const loud = (n: number) => new Float32Array(n).fill(0.5);
const join = (chunks: Iterable<Float32Array>) => {
  const list = [...chunks];
  const out = new Float32Array(list.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of list) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** Silent runs of more than 30 ms, in ms, on 5 ms frames below -50 dBFS. */
function silences(audio: Float32Array, sampleRate: number): number[] {
  const frame = Math.round(sampleRate * 0.005);
  const runs: number[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start > sampleRate * 0.03)
      runs.push(Math.round(((end - start) / sampleRate) * 1000));
    start = -1;
  };
  for (let i = 0; i < audio.length; i += frame) {
    let peak = 0;
    for (let j = i; j < Math.min(audio.length, i + frame); j++)
      peak = Math.max(peak, Math.abs(audio[j] as number));
    if (peak >= QUIET) close(i);
    else if (start < 0) start = i;
  }
  close(audio.length);
  return runs;
}

const QUIET = 10 ** (-50 / 20);

describe("pauseAfter", () => {
  test("a sentence's end pauses longer than a comma or a cut without a mark", () => {
    expect(pauseAfter("here is the plan.")).toBe(0.3);
    expect(pauseAfter('He said "no!"')).toBe(0.3);
    expect(pauseAfter("Sure,")).toBe(0.14);
    expect(pauseAfter("First item")).toBe(0.14);
  });
});

describe("withPause", () => {
  test("cuts a long silent tail to the pause", () => {
    const out = join(withPause([loud(10), new Float32Array(50), new Float32Array(50)], 20));
    expect(out.length).toBe(30);
    expect(out[9]).toBe(0.5);
  });

  test("pads a short tail with zeros, and cuts inside the last loud chunk", () => {
    expect(join(withPause([loud(10), new Float32Array(5)], 20)).length).toBe(30);
    const ending = loud(10);
    ending.fill(0, 4);
    expect(join(withPause([ending], 2)).length).toBe(6);
  });

  test("counts samples before handing a chunk over, as a worker transfers it and empties it", () => {
    // The worker posts each chunk with its buffer transferred; lengths read after that were 0, and
    // the pause grew by the whole last loud chunk.
    let total = 0;
    for (const chunk of withPause([loud(10), new Float32Array(8), new Float32Array(8)], 12)) {
      total += chunk.length;
      structuredClone(chunk, { transfer: [chunk.buffer] });
    }
    expect(total).toBe(22);
  });

  test("passes speech and the silences inside it untouched", () => {
    const chunks = [new Float32Array(8), loud(4), new Float32Array(30), loud(4), new Float32Array(9)];
    const out = [...withPause(chunks, 3)];
    expect(out.slice(0, 4)).toEqual(chunks.slice(0, 4));
    expect(out[0]).toBe(chunks[0] as Float32Array);
    expect(join(out).length).toBe(8 + 4 + 30 + 4 + 3);
  });
});

describe("speech", () => {
  let voice: Voice;
  beforeAll(async () => {
    voice = await createVoice({ wasm, dictionary });
  });

  test("pauses after each clause as the whole text would: short at a comma, longer after a sentence", async () => {
    async function* tokens() {
      yield* "Sure, here is the plan. Well.".match(/.{1,3}/gs) ?? [];
    }
    const chunks: Float32Array[] = [];
    for await (const chunk of speech(voice, tokens())) chunks.push(chunk);
    const gaps = silences(join(chunks), voice.sampleRate);
    // Clause by clause, unpaced, both were about 230 ms; whole, the engine pauses about 140 and 300.
    expect(gaps[0]).toBeGreaterThanOrEqual(130);
    expect(gaps[0]).toBeLessThan(200);
    expect(Math.max(...gaps.slice(1, -1))).toBeGreaterThanOrEqual(290);
    expect(gaps.at(-1)).toBeGreaterThan(290);
    expect(gaps.at(-1)).toBeLessThanOrEqual(300);
  });

  test("a string is one utterance, its end paused like a sentence", async () => {
    const chunks: Float32Array[] = [];
    for await (const chunk of speech(voice, "Hello there.")) chunks.push(chunk);
    const whole = voice.render("Hello there.").audio;
    const paced = join(chunks);
    let end = whole.length;
    while (end > 0 && Math.abs(whole[end - 1] as number) < QUIET) end--;
    expect(paced.length).toBe(end + Math.round(voice.sampleRate * 0.3));
    expect(Array.from(paced.subarray(0, end))).toEqual(Array.from(whole.subarray(0, end)));
  });
});
