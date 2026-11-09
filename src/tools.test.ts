import { describe, expect, test } from "bun:test";
import { MOODS } from "./delivery.ts";
import { createVoice } from "./index.ts";
import type { Song } from "./layers.ts";
import { melody } from "./melody.ts";
import { createToolRunner, forAnthropic, forOpenAI, TOOLS, type ToolSayOptions } from "./tools.ts";
import type { AsyncVoice } from "./worker-voice.ts";

describe("melody", () => {
  test("reads names, accidentals and lengths: C4 is 60, A4 is 69", () => {
    expect(melody("C4:1 A4:0.5 D#4:2 Bb3:.25 c-1:1")).toEqual([
      { midi: 60, beats: 1 },
      { midi: 69, beats: 0.5 },
      { midi: 63, beats: 2 },
      { midi: 58, beats: 0.25 },
      { midi: 0, beats: 1 },
    ]);
  });

  test("a length defaults to one beat, a pitch can be a MIDI number, bars are ignored", () => {
    expect(melody(" 60:2 | 61.5  C4 |\n")).toEqual([
      { midi: 60, beats: 2 },
      { midi: 61.5, beats: 1 },
      { midi: 60, beats: 1 },
    ]);
  });

  test("a lower-case b is the note B, and bb3 is B flat", () => {
    expect(melody("b3 bb3").map((note) => note.midi)).toEqual([59, 58]);
  });

  test("refuses a rest instead of shifting the syllables after it", () => {
    for (const rest of ["r:1", "R", "rest:2", "_", "-", "~:1"]) {
      expect(() => melody(`C4:1 ${rest} D4:1`)).toThrow(/rest/);
    }
  });

  test("refuses what is not a note, a bad length, and pitches outside MIDI", () => {
    for (const bad of ["H4:1", "C:1", "C4:1:2", "hello"]) {
      expect(() => melody(bad)).toThrow(/not a note/);
    }
    for (const bad of ["C4:0", "C4:-1", "C4:x", "C4:", "C4:Infinity"]) {
      expect(() => melody(bad)).toThrow(/length/);
    }
    for (const bad of ["G#9:1", "128:1", "C-2:1"]) {
      expect(() => melody(bad)).toThrow(/MIDI/);
    }
    for (const empty of ["", "  ", "| |"]) expect(() => melody(empty)).toThrow(/at least one/);
  });
});

describe("the definitions", () => {
  test("are shaped for each API, with every mood the library has", () => {
    const [say] = forAnthropic();
    expect(Object.keys(say as object).sort()).toEqual(["description", "input_schema", "name"]);
    expect(say?.input_schema.required).toEqual(["text"]);
    expect(say?.input_schema.properties.mood?.enum).toEqual(Object.keys(MOODS));
    const [first] = forOpenAI();
    expect(first?.type).toBe("function");
    expect(first?.function.name).toBe("say");
    expect(first?.function.parameters.additionalProperties).toBe(false);
  });

  test("survive JSON, as they are sent over the network", () => {
    expect(JSON.parse(JSON.stringify(TOOLS))).toEqual(TOOLS as never);
  });
});

/** A voice that records its calls and finishes each one when told to. */
function fakeVoice(lost?: string[]) {
  const calls: { input: string | Song; options?: ToolSayOptions | undefined; stopped: boolean }[] = [];
  const finishers: (() => void)[] = [];
  return {
    calls,
    finish: () => finishers.shift()?.(),
    say(input: string | Song, options?: ToolSayOptions) {
      const call = { input, options, stopped: false };
      calls.push(call);
      const done = new Promise<void>((resolve) => finishers.push(resolve));
      return {
        queued: Promise.resolve(),
        done,
        lost,
        stop: () => {
          call.stopped = true;
          finishers.shift()?.();
        },
      };
    },
  };
}

/** A turn of the event loop, for what a queue has to do next. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a tool runner", () => {
  test("says text and answers when the speech has finished", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice);
    let settled = false;
    const result = runner.run("say", { text: "hello", mood: "calm", intensity: 0.5, rate: 1.2 });
    void result.then(() => {
      settled = true;
    });
    await tick();
    expect(voice.calls[0]?.input).toBe("hello");
    expect(voice.calls[0]?.options).toEqual({ delivery: "calm", intensity: 0.5, rate: 1.2 });
    expect(settled).toBe(false);
    voice.finish();
    expect(await result).toEqual({ ok: true, lost: [] });
  });

  test("sings a melody written as text, and passes neither rate nor f0, which a song refuses", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice, { body: "female", f0: 200, rate: 1.1, mood: "happy" });
    const result = runner.run("sing", {
      lyrics: "sun-light ~",
      melody: "C4:1 D4:0.5 E4:2",
      bpm: 90,
      vibrato: 30,
    });
    await tick();
    expect(voice.calls[0]?.input).toEqual({
      lyrics: "sun-light ~",
      notes: [
        { midi: 60, beats: 1 },
        { midi: 62, beats: 0.5 },
        { midi: 64, beats: 2 },
      ],
      bpm: 90,
      vibrato: 30,
    });
    expect(voice.calls[0]?.options).toEqual({ body: "female", delivery: "happy" });
    voice.finish();
    await result;
  });

  test("set_voice lasts, a call's own mood wins, and leaving a field out resets it", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice, { body: "male" });
    expect(await runner.run("set_voice", { body: "child", rate: 1.3, mood: "sad" })).toEqual({
      ok: true,
      voice: { body: "child", rate: 1.3, mood: "sad" },
    });
    const first = runner.run("say", { text: "one", mood: "angry" });
    await tick();
    expect(voice.calls[0]?.options).toEqual({ body: "child", rate: 1.3, delivery: "angry" });
    voice.finish();
    await first;

    expect(await runner.run("set_voice", {})).toEqual({ ok: true, voice: { body: "male" } });
    const second = runner.run("say", { text: "two" });
    await tick();
    expect(voice.calls[1]?.options).toEqual({ body: "male" });
    voice.finish();
    await second;
  });

  test("tells the model what was wrong, and never throws or speaks", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice);
    const refused: [string, unknown, RegExp][] = [
      ["shout", { text: "hi" }, /no tool named "shout".*say, sing, set_voice/],
      ["say", "hi", /object of named arguments/],
      ["say", ["hi"], /object of named arguments/],
      ["say", {}, /needs "text"/],
      ["say", { text: "   " }, /must not be empty/],
      ["say", { text: 3 }, /must be a string/],
      ["say", { text: "hi", volume: 1 }, /no argument "volume".*text, mood/],
      ["say", { text: "hi", toString: 1 }, /no argument "toString"/],
      ["say", { text: "hi", mood: "furious" }, /one of neutral, happy.*"furious"/],
      ["say", { text: "hi", rate: 0 }, /above 0 up to 4; got 0/],
      ["say", { text: "hi", rate: 5 }, /above 0 up to 4; got 5/],
      ["say", { text: "hi", rate: "fast" }, /must be a number/],
      ["say", { text: "hi", intensity: Number.NaN }, /must be a number/],
      ["sing", { lyrics: "la", bpm: 90 }, /needs "melody"/],
      ["sing", { lyrics: "la", melody: "r:1", bpm: 90 }, /a rest/],
      ["set_voice", { f0: 5 }, /from 20 up to 2000; got 5/],
      ["set_voice", { body: { female: 1 } }, /must be a string/],
    ];
    for (const [name, input, why] of refused) {
      const result = await runner.run(name, input);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toMatch(why);
    }
    expect(voice.calls).toEqual([]);
  });

  test("a null is an argument left out, as some models send", async () => {
    const voice = fakeVoice();
    const result = createToolRunner(voice).run("say", { text: "hi", mood: null, rate: null });
    await tick();
    expect(voice.calls[0]?.options).toEqual({});
    voice.finish();
    expect((await result).ok).toBe(true);
  });

  test("speaks calls made at once one after the other, in order", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice);
    const first = runner.run("say", { text: "one" });
    const second = runner.run("say", { text: "two" });
    await tick();
    expect(voice.calls.map((call) => call.input)).toEqual(["one"]);
    voice.finish();
    await first;
    await tick();
    expect(voice.calls.map((call) => call.input)).toEqual(["one", "two"]);
    voice.finish();
    await second;
  });

  test("a set_voice between two calls made at once applies to the second only", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice);
    const first = runner.run("say", { text: "one" });
    await runner.run("set_voice", { body: "child" });
    const second = runner.run("say", { text: "two" });
    await tick();
    voice.finish();
    await first;
    await tick();
    voice.finish();
    await second;
    expect(voice.calls[0]?.options).toEqual({});
    expect(voice.calls[1]?.options).toEqual({ body: "child" });
  });

  test("stop interrupts what is speaking and drops what is waiting, then it speaks again", async () => {
    const voice = fakeVoice();
    const runner = createToolRunner(voice);
    const speaking = runner.run("say", { text: "one" });
    const waiting = runner.run("say", { text: "two" });
    await tick();
    runner.stop();
    expect(voice.calls[0]?.stopped).toBe(true);
    expect(await speaking).toEqual({ ok: true, lost: [], interrupted: true });
    expect(await waiting).toEqual({ ok: false, error: "stopped before it started" });
    expect(voice.calls.length).toBe(1);

    const again = runner.run("say", { text: "three" });
    await tick();
    expect(voice.calls[1]?.input).toBe("three");
    voice.finish();
    expect(await again).toEqual({ ok: true, lost: [] });
  });

  test("reports what the backend could not do", async () => {
    const voice = fakeVoice(["notes"]);
    const result = createToolRunner(voice).run("sing", { lyrics: "la", melody: "C4", bpm: 90 });
    await tick();
    voice.finish();
    expect(await result).toEqual({ ok: true, lost: ["notes"] });
  });

  test("a voice that throws, or fails while playing, becomes a result and the queue goes on", async () => {
    const threw = createToolRunner({
      say() {
        throw new Error("intone: notes.len() (1) must equal the lyrics' syllable count (2)");
      },
    });
    expect(await threw.run("say", { text: "hi" })).toEqual({
      ok: false,
      error: "notes.len() (1) must equal the lyrics' syllable count (2)",
    });

    let attempts = 0;
    const failing = createToolRunner({
      say: () => {
        attempts += 1;
        return {
          queued: attempts === 1 ? Promise.reject(new Error("no audio")) : Promise.resolve(),
          done: Promise.resolve(),
          stop() {},
        };
      },
    });
    expect(await failing.run("say", { text: "one" })).toEqual({ ok: false, error: "no audio" });
    expect((await failing.run("say", { text: "two" })).ok).toBe(true);
  });

  test("refuses bad defaults at once, as those are the developer's", () => {
    expect(() => createToolRunner(fakeVoice(), { rate: 9 })).toThrow(/up to 4/);
  });

  test("takes a worker voice as it is", () => {
    const accepts = (voice: AsyncVoice) => createToolRunner(voice);
    expect(typeof accepts).toBe("function");
  });
});

describe("a tool runner on the real engine", () => {
  const wasm = new URL("../dist/intone_chimera.wasm", import.meta.url);
  const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);

  /** Renders instead of playing, as Bun has no audio device. */
  async function rendering() {
    const voice = await createVoice({ wasm, dictionary });
    const seconds: number[] = [];
    const runner = createToolRunner({
      say(input) {
        const { audio, sampleRate } = voice.render(input);
        seconds.push(audio.length / sampleRate);
        return { queued: Promise.resolve(), done: Promise.resolve(), stop() {} };
      },
    });
    return { voice, seconds, runner };
  }

  test("a song written as a model writes it is sung for as long as its beats", async () => {
    const { voice, seconds, runner } = await rendering();
    const result = await runner.run("sing", {
      lyrics: "sun-light on the wa-ter ~",
      melody: "C4:1 D4:1 | E4:1 G4:1 | A4:1 G4:1 E4:2",
      bpm: 120,
    });
    expect(result).toEqual({ ok: true, lost: [] });
    // Eight beats at 120 are four seconds, plus the first consonants and the engine's tail.
    expect(seconds[0]).toBeGreaterThan(3.9);
    expect(seconds[0]).toBeLessThan(5);
    voice.free();
  });

  test("the engine's complaint about syllables reaches the model", async () => {
    const { voice, runner } = await rendering();
    const result = await runner.run("sing", { lyrics: "sun-light", melody: "C4", bpm: 120 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/syllable count/);
    voice.free();
  });
});
