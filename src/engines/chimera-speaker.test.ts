import { afterEach, describe, expect, test } from "bun:test";
import { createVoice } from "../index.ts";
import type { Speaker } from "../speaker.ts";
import { createChimeraSpeaker } from "./chimera-speaker.ts";

const wasm = new URL("../../dist/intone_chimera.wasm", import.meta.url);
const dictionary = new URL("../../dist/cmudict.txt.gz", import.meta.url);
const TEXT = "The birch canoe slid on the smooth planks.";

let speaker: Speaker | undefined;
afterEach(() => {
  speaker?.free();
  speaker = undefined;
});

async function collect(chunks: AsyncIterable<Float32Array>): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return join(parts);
}

function join(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe("createChimeraSpeaker", () => {
  test("describes the backend", async () => {
    speaker = await createChimeraSpeaker({
      worker: new Worker(new URL("../worker.ts", import.meta.url)),
      wasm,
      dictionary,
      body: "female",
    });
    expect(speaker.id).toBe("chimera");
    expect(speaker.accepts).toBe("gestures");
    expect(speaker.output).toBe("samples");
    expect(speaker.sampleRate).toBe(48_000);
    expect(speaker.supports.pitchCurve).toBe(true);
  });

  test("render and stream give exactly createVoice's samples, nothing lost", async () => {
    speaker = await createChimeraSpeaker({
      worker: new Worker(new URL("../worker.ts", import.meta.url)),
      wasm,
      dictionary,
      body: "female",
    });
    const here = await createVoice({ wasm, dictionary, body: "female" });
    const expected = here.render(TEXT).audio;
    here.free();

    const rendered = await speaker.render?.(TEXT);
    expect(rendered?.audio).toEqual(expected);
    expect(rendered?.lost).toEqual([]);

    const gen = speaker.stream?.(TEXT, { chunkSize: 512 });
    if (!gen) throw new Error("stream missing");
    const chunks: Float32Array[] = [];
    let result = await gen.next();
    while (!result.done) {
      chunks.push(result.value);
      result = await gen.next();
    }
    expect(result.value).toEqual([]);
    expect(join(chunks)).toEqual(expected);
  });

  test("sings a song as createVoice does, nothing lost", async () => {
    speaker = await createChimeraSpeaker({
      worker: new Worker(new URL("../worker.ts", import.meta.url)),
      wasm,
      dictionary,
      body: "female",
    });
    const song = {
      lyrics: "la la",
      notes: [60, 67].map((midi) => ({ midi, beats: 1 })),
      bpm: 120,
      vibrato: 30,
    };
    const here = await createVoice({ wasm, dictionary, body: "female" });
    const expected = here.render(song).audio;
    here.free();
    expect(speaker.supports.singing).toBe(true);
    const rendered = await speaker.render?.(song);
    expect(rendered?.audio).toEqual(expected);
    expect(rendered?.lost).toEqual([]);
    const gen = speaker.stream?.(song);
    if (!gen) throw new Error("stream missing");
    expect(await collect(gen)).toEqual(expected);
  });

  test("passes the engine's errors on", async () => {
    speaker = await createChimeraSpeaker({
      worker: new Worker(new URL("../worker.ts", import.meta.url)),
      wasm,
      dictionary,
    });
    const gen = speaker.stream?.(TEXT, { rate: 100 });
    if (!gen) throw new Error("stream missing");
    await expect(collect(gen as AsyncIterable<Float32Array>)).rejects.toThrow("intone");
  });
});
