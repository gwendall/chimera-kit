import { describe, expect, test } from "bun:test";
import { createWebSpeechSpeaker, lostFor } from "./web-speech-speaker.js";

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

/** Speaks each utterance in 5 ms, one after the other, like a system queue. */
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
    }, 5);
  }
}

const VOICES = [voice("Samantha", "en-US")];

function setup() {
  const synth = new FakeSynth(VOICES);
  return {
    synth,
    options: {
      synth: synth as unknown as SpeechSynthesis,
      Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    },
  };
}

describe("lostFor", () => {
  test("f0, accent and body are always lost when given; rate is not", () => {
    expect(lostFor({ rate: 1.2 })).toEqual([]);
    expect(lostFor({ f0: 180, accent: 0.5, body: "female" }).sort()).toEqual(["accent", "body", "f0"]);
  });
  test("nothing lost when nothing beyond rate is asked", () => {
    expect(lostFor(undefined)).toEqual([]);
  });
});

describe("createWebSpeechSpeaker", () => {
  test("describes the backend by the voice it picked", async () => {
    const { options } = setup();
    const speaker = await createWebSpeechSpeaker(options);
    expect(speaker.id).toBe("web-speech");
    expect(speaker.accepts).toBe("intent");
    expect(speaker.output).toBe("playback");
    expect(speaker.sampleRate).toBeUndefined();
    expect(speaker.render).toBeUndefined();
    expect(speaker.stream).toBeUndefined();
    expect(speaker.supports.langs).toEqual(["en-US"]);
    expect(speaker.supports.bodies).toEqual(["Samantha"]);
  });

  test("say speaks the text and reports what was asked that it could not do", async () => {
    const { synth, options } = setup();
    const speaker = await createWebSpeechSpeaker(options);
    const spoken = speaker.say("Hello there.", { rate: 1.2, f0: 300 });
    await spoken.queued;
    await spoken.done;
    expect(synth.spoken.map((u) => u.text)).toEqual(["Hello there."]);
    expect(synth.spoken[0]?.rate).toBeCloseTo(1.2, 9);
    expect(spoken.lost).toEqual(["f0"]);
  });

  test("cannot sing: say speaks a song's lyrics and says its notes are lost", async () => {
    const { synth, options } = setup();
    const speaker = await createWebSpeechSpeaker(options);
    expect(speaker.supports.singing).toBe(false);
    const song = { lyrics: "Twin-kle lit-tle star", notes: [], bpm: 100, t0: 1 };
    const spoken = speaker.say(song);
    await spoken.done;
    expect(synth.spoken.map((u) => u.text)).toEqual(["Twinkle little star"]);
    expect(spoken.lost).toEqual(["notes", "t0"]);
    expect(() => speaker.say(song, { rate: 1.2 })).toThrow("intone: a song ignores rate");
  });

  test("say hands a delivery to the system voice at its intensity, its rate times the call's", async () => {
    const { synth, options } = setup();
    const speaker = await createWebSpeechSpeaker(options);
    const spoken = speaker.say("Hello there.", {
      delivery: { rate: 0.64, pitch: 12, breath: 0.4 },
      intensity: 0.5,
      rate: 1.5,
    });
    await spoken.done;
    expect(synth.spoken[0]?.rate).toBeCloseTo(1.2, 9);
    expect(synth.spoken[0]?.pitch).toBeCloseTo(1.5, 9);
    expect(spoken.lost).toEqual(["breath"]);
  });

  test("stop cuts speech short", async () => {
    const { synth, options } = setup();
    const speaker = await createWebSpeechSpeaker(options);
    const spoken = speaker.say("One two three. Four five six. Seven eight nine.");
    setTimeout(() => spoken.stop(), 8);
    await spoken.done;
    expect(synth.spoken.length).toBeLessThan(3);
  });
});
