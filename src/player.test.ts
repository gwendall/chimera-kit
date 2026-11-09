import { afterEach, describe, expect, test } from "bun:test";
import { play, unlockAudio } from "./player.js";

const real = {
  navigator: globalThis.navigator,
  AudioContext: globalThis.AudioContext,
  AudioWorkletNode: globalThis.AudioWorkletNode,
  Audio: globalThis.Audio,
};
const browser = (value: object) =>
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });

afterEach(() => {
  browser(real.navigator);
  Object.assign(globalThis, {
    AudioContext: real.AudioContext,
    AudioWorkletNode: real.AudioWorkletNode,
    Audio: real.Audio,
  });
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

  test("settles queued and rejects done when the worklet cannot load, rather than hanging", async () => {
    browser({});
    class FakeContext {
      state = "running";
      audioWorklet = { addModule: () => Promise.reject(new Error("no worklet here")) };
      async resume() {}
    }
    Object.assign(globalThis, { AudioContext: FakeContext });
    const playback = play([], 48_000, { context: new FakeContext() as unknown as BaseAudioContext });
    await playback.queued;
    await expect(playback.done).rejects.toThrow("no worklet here");
  });

  test("ends when the caller closes its own context mid-stream, though the worklet never says so", async () => {
    browser({});
    class FakeContext extends EventTarget {
      state = "running";
      currentTime = 0;
      destination = {};
      audioWorklet = { addModule: async () => {} };
      async resume() {}
    }
    const posted: unknown[] = [];
    class FakeNode {
      port = { postMessage: (message: unknown) => posted.push(message), onmessage: null };
      connect() {}
      disconnect() {
        throw new DOMException("the context is closed", "InvalidStateError");
      }
    }
    Object.assign(globalThis, { AudioContext: FakeContext, AudioWorkletNode: FakeNode });
    const context = new FakeContext();
    const playback = play([new Float32Array(128)], 48_000, {
      context: context as unknown as BaseAudioContext,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    context.state = "closed";
    context.dispatchEvent(new Event("statechange"));
    expect(await playback.done).toEqual({ underruns: 0 });
    await playback.queued;
    expect(posted).toContain("stop");
  });
});
