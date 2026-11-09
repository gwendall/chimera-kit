/**
 * Kokoro behind the shared `Speaker` interface (`../speaker.ts`). Reachable only through
 * `createSpeaker("kokoro", ...)`, which `import()`s this file, so `kokoro-js` and its model never
 * reach an app that doesn't ask for this engine. `speakerFromKokoro` is split out from
 * `createKokoroSpeaker` so it can be tested with a fake `KokoroVoice`, without the real model.
 *
 * Kokoro has no input for pitch or per-sound timing at all (see `./kokoro.ts`'s module doc), and
 * its voice is fixed when the speaker is opened, not per call: a text request's `f0`, `accent` and
 * `body` are always lost when given, `rate` is honored exactly (mapped straight to Kokoro's own
 * `speed`), and a `chunkSize` is ignored (Kokoro's only granularity is a whole clause).
 */
import { clauses } from "../clauses.js";
import type { Body, SpeakOptions } from "../engine.js";
import { type PlayOptions, play } from "../player.js";
import type { Speaker, SpeakerSayOptions, SpokenPlayback, SpokenRendered, Supports } from "../speaker.js";
import type { StreamOptions } from "../voice.js";
import {
  createKokoroVoice,
  KOKORO_SAMPLE_RATE,
  type KokoroVoice,
  type KokoroVoiceOptions,
} from "./kokoro.js";

export interface KokoroSpeakerOptions extends KokoroVoiceOptions {
  /** A shared body, approximated to the nearest Kokoro voice (see `BODY_VOICES`); `voice` wins. */
  body?: Body;
}

const SUPPORTS: Supports = {
  pitchCurve: false,
  soundTiming: false,
  breath: false,
  phones: true,
  langs: ["en"],
  bodies: ["male", "female"],
};

/** Kokoro's own English voice ids nearest to the shared bodies. There is no child voice; the
 * female voice is the nearest available, and `lost` says so on any call that asks for one. */
export const BODY_VOICES: Readonly<Record<"male" | "female" | "child", string>> = {
  female: "af_heart",
  male: "am_adam",
  child: "af_heart",
};

/** The Kokoro voice id to open: an explicit `voice` wins, then a plain `"male"`/`"female"`/
 * `"child"` body, then the default. A blend body has no equivalent and falls back to the default. */
export function voiceFor(options: KokoroSpeakerOptions): string | undefined {
  if (options.voice !== undefined) return options.voice;
  if (typeof options.body === "string" && options.body in BODY_VOICES) {
    return BODY_VOICES[options.body as "male" | "female" | "child"];
  }
  return undefined;
}

/** What a call's options ask for that Kokoro cannot do: `f0` and `accent` have no input at all,
 * `body` cannot change after the speaker was opened, and `chunkSize` has no meaning here. */
export function lostFor(options?: StreamOptions): string[] {
  const lost: string[] = [];
  if (options?.f0 !== undefined) lost.push("f0");
  if (options?.accent !== undefined) lost.push("accent");
  if (options?.body !== undefined) lost.push("body");
  if (options?.chunkSize !== undefined) lost.push("chunk size");
  return lost;
}

async function* chunksOf(
  voice: KokoroVoice,
  text: string | Iterable<string> | AsyncIterable<string>,
  options?: SpeakOptions,
): AsyncGenerator<Float32Array, void, undefined> {
  const pieces = typeof text === "string" ? [text] : clauses(text);
  for await (const clause of pieces) {
    for await (const chunk of voice.stream(clause, options)) yield chunk;
  }
}

/** Wraps an already-open `KokoroVoice` as a `Speaker`. Exported for tests; apps use
 * `createKokoroSpeaker` (or `createSpeaker("kokoro", ...)`), which also loads the model. */
export function speakerFromKokoro(voice: KokoroVoice): Speaker {
  return {
    id: "kokoro",
    accepts: "phrasing",
    output: "samples",
    supports: SUPPORTS,
    sampleRate: voice.sampleRate,

    async render(text: string, speakOptions?: StreamOptions): Promise<SpokenRendered> {
      const rendered = await voice.render(text, speakOptions);
      return { ...rendered, lost: lostFor(speakOptions) };
    },

    async *stream(text: string, speakOptions?: StreamOptions) {
      for await (const chunk of voice.stream(text, speakOptions)) yield chunk;
      return lostFor(speakOptions);
    },

    say(text, speakOptions: SpeakerSayOptions = {}): SpokenPlayback {
      const { signal, context, destination, ...rest } = speakOptions;
      const playOptions: PlayOptions = {};
      if (context) playOptions.context = context;
      if (destination) playOptions.destination = destination;
      if (signal) playOptions.signal = signal;
      const playback = play(chunksOf(voice, text, rest), KOKORO_SAMPLE_RATE, playOptions);
      return {
        queued: playback.queued,
        done: playback.done.then(() => undefined),
        lost: lostFor(rest),
        stop: playback.stop,
      };
    },

    free(): void {
      voice.free();
    },
  };
}

/** Loads the Kokoro model (downloads it on first use) and returns a `Speaker` over it. */
export async function createKokoroSpeaker(options: KokoroSpeakerOptions = {}): Promise<Speaker> {
  const voiceId = voiceFor(options);
  const voice = await createKokoroVoice(voiceId !== undefined ? { ...options, voice: voiceId } : options);
  return speakerFromKokoro(voice);
}
