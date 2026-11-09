import { describe, expect, test } from "bun:test";
import { MOODS } from "./delivery.ts";
import { createSystemVoice, systemSettings, systemVoices } from "./web-speech.ts";

interface FakeVoice {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
  voiceURI: string;
}

const voice = (name: string, lang: string, localService = true): FakeVoice => ({
  name,
  lang,
  localService,
  default: false,
  voiceURI: name,
});

class FakeUtterance {
  voice: FakeVoice | null = null;
  lang = "";
  rate = 1;
  pitch = 1;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

/** Speaks each utterance in 10 ms, one after the other, like a system queue. */
class FakeSynth extends EventTarget {
  spoken: FakeUtterance[] = [];
  private queue: FakeUtterance[] = [];
  private busy = false;
  constructor(private voices: FakeVoice[]) {
    super();
  }
  getVoices() {
    return this.voices;
  }
  list(voices: FakeVoice[]) {
    this.voices = voices;
    this.dispatchEvent(new Event("voiceschanged"));
  }
  speak(u: FakeUtterance) {
    this.queue.push(u);
    this.next();
  }
  cancel() {
    const pending = this.queue;
    this.queue = [];
    for (const u of pending) u.onerror?.();
  }
  private next() {
    if (this.busy) return;
    const u = this.queue[0];
    if (!u) return;
    this.busy = true;
    setTimeout(() => {
      this.busy = false;
      if (this.queue[0] !== u) return this.next();
      this.queue.shift();
      this.spoken.push(u);
      u.onend?.();
      this.next();
    }, 10);
  }
}

const VOICES = [
  voice("Google US English", "en-US", false),
  voice("Samantha", "en-US"),
  voice("Thomas", "fr-FR"),
];

function setup(voices = VOICES) {
  const synth = new FakeSynth(voices);
  const options = {
    synth: synth as unknown as SpeechSynthesis,
    Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
  };
  return { synth, options };
}

async function* tokens(text: string) {
  for (const piece of text.match(/.{1,3}/gs) ?? []) {
    await Bun.sleep(1);
    yield piece;
  }
}

describe("systemSettings", () => {
  test("map a mood to rate, pitch and volume, and name the rest as lost", () => {
    const s = systemSettings("sad");
    expect(s.rate).toBeCloseTo(MOODS.sad.rate, 9);
    expect(s.pitch).toBeCloseTo(1 - 2 / 12, 9);
    expect(s.volume).toBeCloseTo(10 ** (-4 / 20), 9);
    expect(s.lost).toEqual(["pitch range", "breath", "tension", "pause length"]);
  });

  test("cannot go louder than full volume, and say so", () => {
    const s = systemSettings({ gain: 6 });
    expect(s.volume).toBe(1);
    expect(s.lost).toEqual(["level above full volume"]);
  });

  test("intensity 0 is neutral and loses nothing", () => {
    expect(systemSettings("angry", 0)).toEqual({ rate: 1, pitch: 1, volume: 1, lost: [] });
  });
});

describe("createSystemVoice", () => {
  test("prefers a voice on the device for the language, or the one named", async () => {
    const { options } = setup();
    expect((await createSystemVoice(options)).voice.name).toBe("Samantha");
    expect((await createSystemVoice({ ...options, name: /google/i })).voice.name).toBe("Google US English");
    expect((await createSystemVoice({ ...options, lang: "fr" })).voice.name).toBe("Thomas");
  });

  test("names the voices it has when none fits", async () => {
    const { options } = setup();
    await expect(createSystemVoice({ ...options, lang: "ja" })).rejects.toThrow("Voices: none");
    await expect(createSystemVoice({ ...options, name: "Alex" })).rejects.toThrow(
      "Voices: Google US English, Samantha",
    );
  });

  test("waits for voices that the browser lists late", async () => {
    const { synth } = setup([]);
    setTimeout(() => synth.list(VOICES), 5);
    expect((await systemVoices(synth as unknown as SpeechSynthesis)).length).toBe(3);
  });
});

describe("say", () => {
  test("speaks text that is still arriving, clause by clause, with the delivery", async () => {
    const { synth, options } = setup();
    const v = await createSystemVoice(options);
    const speech = v.say(tokens("Sure, here is the **plan**. Wait for it.\n```\ncode()\n```\nDone!"), {
      delivery: "happy",
    });
    await speech.done;
    expect(synth.spoken.map((u) => u.text)).toEqual(["Sure,", "here is the plan.", "Wait for it.", "Done!"]);
    expect(synth.spoken[0]?.rate).toBeCloseTo(MOODS.happy.rate, 9);
    expect(synth.spoken[0]?.voice?.name).toBe("Samantha");
    expect(speech.lost).toContain("pitch range");
  });

  test("stops when asked", async () => {
    const { synth, options } = setup();
    const v = await createSystemVoice(options);
    const controller = new AbortController();
    const speech = v.say(tokens("One two three. Four five six. Seven eight nine."), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 15);
    await speech.done;
    expect(synth.spoken.length).toBeLessThan(3);
  });
});
