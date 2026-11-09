import { describe, expect, test } from "bun:test";
import type { Score } from "../layers.js";
import type { StreamOptions } from "../voice.js";
import {
  KOKORO_SAMPLE_RATE,
  type KokoroRenderedScore,
  type KokoroSpeakOptions,
  type KokoroVoice,
} from "./kokoro.js";
import { BODY_VOICES, forKokoro, lostFor, speakerFromKokoro, voiceFor } from "./kokoro-speaker.js";

/** A `KokoroVoice` that needs no model: records what it was asked and returns deterministic,
 * cheap audio, so `speakerFromKokoro` can be tested without `kokoro-js` or a download. */
class FakeKokoroVoice implements KokoroVoice {
  readonly sampleRate = KOKORO_SAMPLE_RATE;
  rate: number | undefined;
  freed = false;
  calls: { text: string; options: KokoroSpeakOptions | undefined }[] = [];

  async render(text: string, options?: KokoroSpeakOptions) {
    this.calls.push({ text, options });
    return { audio: Float32Array.from([text.length]), sampleRate: this.sampleRate };
  }

  async *stream(text: string, options?: KokoroSpeakOptions) {
    this.calls.push({ text, options });
    yield Float32Array.from([text.length]);
  }

  async renderScore(_score: Score, _options?: KokoroSpeakOptions): Promise<KokoroRenderedScore> {
    throw new Error("not used by these tests");
  }

  free() {
    this.freed = true;
  }
}

describe("voiceFor", () => {
  test("an explicit voice wins over a body", () => {
    expect(voiceFor({ voice: "af_bella", body: "male" })).toBe("af_bella");
  });
  test("maps the shared bodies to Kokoro's nearest voice", () => {
    expect(voiceFor({ body: "female" })).toBe(BODY_VOICES.female);
    expect(voiceFor({ body: "male" })).toBe(BODY_VOICES.male);
    expect(voiceFor({ body: "child" })).toBe(BODY_VOICES.child); // no child voice: approximated
  });
  test("a blend body and no body at all fall back to the default voice", () => {
    expect(voiceFor({ body: { female: 0.5, child: 0.5 } })).toBeUndefined();
    expect(voiceFor({})).toBeUndefined();
  });
});

describe("lostFor", () => {
  test("rate alone is fully honored", () => {
    expect(lostFor({ rate: 1.3 })).toEqual([]);
  });
  test("f0, accent and a per-call body are always lost when given", () => {
    const opts: StreamOptions = { f0: 180, accent: 0.5, body: "male" };
    expect(lostFor(opts).sort()).toEqual(["accent", "body", "f0"]);
  });
  test("a chunkSize has no meaning for Kokoro's whole-clause chunks", () => {
    expect(lostFor({ chunkSize: 512 })).toEqual(["chunk size"]);
  });
  test("nothing lost when nothing beyond rate is asked", () => {
    expect(lostFor(undefined)).toEqual([]);
    expect(lostFor({})).toEqual([]);
  });
});

describe("forKokoro", () => {
  test("a delivery's rate multiplies the call's rate, or else the voice's own", () => {
    expect(forKokoro({ delivery: { rate: 0.8 }, rate: 1.5 }, 2).speak.rate).toBeCloseTo(1.2, 9);
    expect(forKokoro({ delivery: { rate: 0.8 } }, 1.25).speak.rate).toBeCloseTo(1, 9);
    expect(forKokoro({ delivery: { rate: 0.8 } }).speak.rate).toBeCloseTo(0.8, 9);
    expect(forKokoro({ delivery: { rate: 0.64 }, intensity: 0.5 }).speak.rate).toBeCloseTo(0.8, 9);
    expect(forKokoro({ rate: 1.5 }, 2).speak).toEqual({ rate: 1.5 });
    expect(forKokoro({}, 2).speak).toEqual({});
  });

  test("the rest of a delivery is lost, by name, and none of it at intensity 0", () => {
    expect(forKokoro({ delivery: "sad" }).lost).toEqual([
      "pitch",
      "pitch range",
      "level",
      "breath",
      "tension",
      "pause length",
    ]);
    expect(forKokoro({ delivery: "sad", intensity: 0 }).lost).toEqual([]);
    expect(forKokoro({ delivery: { rate: 1.1, gain: 3 }, f0: 200 }).lost).toEqual(["f0", "level"]);
  });
});

describe("speakerFromKokoro", () => {
  test("describes the backend", () => {
    const speaker = speakerFromKokoro(new FakeKokoroVoice());
    expect(speaker.id).toBe("kokoro");
    expect(speaker.accepts).toBe("phrasing");
    expect(speaker.output).toBe("samples");
    expect(speaker.sampleRate).toBe(KOKORO_SAMPLE_RATE);
    expect(speaker.supports.pitchCurve).toBe(false);
    expect(speaker.supports.phones).toBe(true);
  });

  test("render reports what this call could not do", async () => {
    const speaker = speakerFromKokoro(new FakeKokoroVoice());
    const plain = await speaker.render?.("hello");
    expect(plain?.lost).toEqual([]);
    const withF0 = await speaker.render?.("hello", { f0: 200 });
    expect(withF0?.lost).toEqual(["f0"]);
    expect(withF0?.sampleRate).toBe(KOKORO_SAMPLE_RATE);
  });

  test("a delivery reaches Kokoro as its rate, and the rest is reported lost", async () => {
    const voice = new FakeKokoroVoice();
    voice.rate = 1.25;
    const speaker = speakerFromKokoro(voice);
    const slow = await speaker.render?.("hello", { delivery: { rate: 0.8, pitch: 2 } });
    expect(voice.calls[0]?.options?.rate).toBeCloseTo(1, 9);
    expect(slow?.lost).toEqual(["pitch"]);
  });

  test("stream's return value is this call's lost, after every chunk", async () => {
    const speaker = speakerFromKokoro(new FakeKokoroVoice());
    const gen = speaker.stream?.("hello", { accent: 0.4 });
    if (!gen) throw new Error("stream missing");
    const chunks: Float32Array[] = [];
    let result = await gen.next();
    while (!result.done) {
      chunks.push(result.value);
      result = await gen.next();
    }
    expect(chunks.length).toBeGreaterThan(0);
    expect(result.value).toEqual(["accent"]);
  });

  test("cannot sing: speaks a song's lyrics and says its notes are lost", async () => {
    const voice = new FakeKokoroVoice();
    const speaker = speakerFromKokoro(voice);
    expect(speaker.supports.singing).toBe(false);
    const song = { lyrics: "Twin-kle twin-kle ~", notes: [], bpm: 100, vibrato: 40 };
    const sung = await speaker.render?.(song, { delivery: { rate: 0.8, pitch: 2 } });
    expect(voice.calls[0]?.text).toBe("Twinkle twinkle");
    expect(sung?.lost).toEqual(["notes", "vibrato", "pitch"]);
    const gen = speaker.stream?.(song);
    if (!gen) throw new Error("stream missing");
    let result = await gen.next();
    while (!result.done) result = await gen.next();
    expect(result.value).toEqual(["notes", "vibrato"]);
    // The same refusal as a backend that sings: a song's notes set its rate.
    await expect(speaker.render?.(song, { rate: 1.2 }) ?? Promise.resolve()).rejects.toThrow(
      "intone: a song ignores rate",
    );
  });

  test("free releases the underlying voice", () => {
    const voice = new FakeKokoroVoice();
    speakerFromKokoro(voice).free();
    expect(voice.freed).toBe(true);
  });
});
