import { beforeAll, describe, expect, test } from "bun:test";
import { createVoice, deliver, type Note, type Score, type Song, type Voice } from "./index.ts";
import { valueAt } from "./transforms.ts";

const wasm = new URL("../dist/chimera.wasm", import.meta.url);
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
    expect(() => voice.render("")).toThrow("chimera-kit");
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
    expect(() => voice.render({ ...score, duration: -1 })).toThrow("chimera-kit");
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

describe("a song", () => {
  let voice: Voice;
  beforeAll(async () => {
    voice = await createVoice({ wasm, dictionary, body: "female" });
  });

  const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const notes = (...midis: number[]): Note[] => midis.map((midi) => ({ midi, beats: 1 }));
  const SONG: Song = { lyrics: "la la la", notes: notes(60, 64, 67), bpm: 100 };

  test("is planned on its notes: each word at its note's pitch", () => {
    const score = voice.plan(SONG);
    expect(score.words?.map((word) => word.text)).toEqual(["la", "la", "la"]);
    for (const [i, word] of (score.words ?? []).entries()) {
      const middle = valueAt(score.pitch, (word.t0 + word.t1) / 2) as number;
      const cents = 1200 * Math.log2(middle / hz((SONG.notes[i] as Note).midi));
      expect(Math.abs(cents)).toBeLessThan(25);
    }
  });

  test("renders and streams as the score planned from it, with vibrato only when asked", () => {
    const plain = voice.plan(SONG);
    const depth = (score: Score) => Math.max(0, ...(score.vibrato ?? []).map(([, cents]) => cents));
    expect(depth(plain)).toBe(0);
    expect(depth(voice.plan({ ...SONG, vibrato: 50 }))).toBeGreaterThan(30);
    const { audio } = voice.render(SONG);
    expect(audio).toEqual(voice.render(plain).audio);
    expect(rms(audio)).toBeGreaterThan(0.001);
    const streamed = [...voice.stream(SONG, { chunkSize: 4096 })];
    expect(streamed.reduce((n, chunk) => n + chunk.length, 0)).toBe(audio.length);
  });

  test("starts on a consonant without a t0, and puts its first beat on a given one", () => {
    // t0 defaulted to 0 in the engine, which refused every song that starts on a consonant.
    const twinkle: Song = { lyrics: "Twin-kle twin-kle", notes: notes(60, 60, 67, 67), bpm: 100 };
    const first = voice.plan(twinkle).sounds.find((sound) => sound.sound !== "_");
    expect(first?.t0).toBeLessThan(0.001);
    const later = voice.plan({ ...twinkle, t0: 1 }).sounds.find((sound) => sound.sound !== "_");
    expect(later?.t0).toBeGreaterThan(0.8);
    expect(later?.t0).toBeLessThan(1);
  });

  test("takes only the style given with the call, and refuses rate, f0 and accent", async () => {
    const sad = await createVoice({ wasm, dictionary, body: "female", style: deliver("sad") });
    try {
      expect(sad.plan(SONG)).toEqual(voice.plan(SONG));
      expect(sad.plan(SONG, { style: deliver("sad") })).toEqual(deliver("sad")(voice.plan(SONG)));
    } finally {
      sad.free();
    }
    expect(() => voice.render(SONG, { rate: 1.5 })).toThrow("a song ignores rate");
    expect(() => voice.plan(SONG, { f0: 200 })).toThrow("f0");
  });

  test("needs one note per syllable, and says how many of each", () => {
    expect(() => voice.plan({ ...SONG, notes: notes(60, 64) })).toThrow(
      "(2) must equal the lyrics' syllable count (3)",
    );
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
