import { afterEach, describe, expect, test } from "bun:test";
import { play, unlockAudio } from "./player.js";

const real = {
  navigator: globalThis.navigator,
  AudioContext: globalThis.AudioContext,
  Audio: globalThis.Audio,
};
const browser = (value: object) =>
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });

afterEach(() => {
  browser(real.navigator);
  Object.assign(globalThis, { AudioContext: real.AudioContext, Audio: real.Audio });
});

function context(state: string) {
  const fake = { state, resumed: 0, resume: async () => void fake.resumed++ };
  return fake;
}
const unlock = (fake: ReturnType<typeof context>) => unlockAudio(fake as unknown as AudioContext);

describe("unlockAudio", () => {
  test("asks iOS for the playback session, which the silent switch does not mute", () => {
    const navigator = { audioSession: { type: "auto" } };
    browser(navigator);
    unlockAudio();
    expect(navigator.audioSession.type).toBe("playback");
  });

  test("keeps the audio session an app chose for itself", () => {
    const navigator = { audioSession: { type: "ambient" } };
    browser(navigator);
    unlockAudio();
    expect(navigator.audioSession.type).toBe("ambient");
  });

  test("resumes a context that iOS suspended or interrupted, in the same tick", () => {
    browser({ audioSession: { type: "auto" } });
    for (const state of ["suspended", "interrupted"]) {
      const fake = context(state);
      unlock(fake);
      expect(fake.resumed).toBe(1);
    }
    const running = context("running");
    unlock(running);
    expect(running.resumed).toBe(0);
  });

  test("falls back to a looping silent element on an iOS with no audio session API", () => {
    const made: { loop: boolean; paused: boolean; plays: number; src: string }[] = [];
    Object.assign(globalThis, {
      Audio: class {
        loop = false;
        paused = true;
        plays = 0;
        constructor(public src: string) {
          made.push(this);
        }
        setAttribute() {}
        async play() {
          this.plays++;
          this.paused = false;
        }
      },
    });
    browser({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
    });
    unlockAudio();
    unlockAudio();
    expect(made.length).toBe(1);
    expect(made[0]?.loop).toBe(true);
    expect(made[0]?.src.startsWith("data:audio/wav;base64,UklGR")).toBe(true);
    expect(made[0]?.plays).toBe(1);
  });

  test("does nothing on a browser that needs none of it", () => {
    Object.assign(globalThis, {
      Audio: class {
        constructor() {
          throw new Error("should not be created");
        }
      },
    });
    browser({
      userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
      platform: "Linux armv8l",
      maxTouchPoints: 5,
    });
    expect(() => unlockAudio()).not.toThrow();
  });
});

describe("play", () => {
  test("wakes the context before its first await, while still inside the tap", () => {
    browser({ audioSession: { type: "auto" } });
    class FakeContext {
      state = "suspended";
      resumed = 0;
      audioWorklet = { addModule: () => new Promise<void>(() => {}) };
      async resume() {
        this.resumed++;
      }
    }
    Object.assign(globalThis, { AudioContext: FakeContext });
    const fake = new FakeContext();
    play([], 48_000, { context: fake as unknown as BaseAudioContext });
    expect(fake.resumed).toBe(1);
    expect((navigator as unknown as { audioSession: { type: string } }).audioSession.type).toBe("playback");
  });
});
