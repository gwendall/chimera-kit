/**
 * Kokoro behind the shared `Speaker` interface (`../speaker.ts`). Reachable only through
 * `createSpeaker("kokoro", ...)`, which `import()`s this file, so `kokoro-js` and its model never
 * reach an app that doesn't ask for this engine. `speakerFromKokoro` is split out from
 * `createKokoroSpeaker` so it can be tested with a fake `KokoroVoice`, without the real model.
 *
 * Kokoro has no input for pitch or per-sound timing at all (see `./kokoro.ts`'s module doc), and
 * its voice is fixed when the speaker is opened, not per call: a text request's `f0`, `accent` and
 * `body` are always lost when given, `rate` is honored exactly (mapped straight to Kokoro's own
 * `speed`), and a `chunkSize` is ignored (Kokoro's only granularity is a whole clause). Kokoro
 * cannot sing: a song's lyrics are spoken, and its notes are lost.
 */
import { clauses } from "../clauses.js";
import { atIntensity, departures } from "../delivery.js";
import type { Body } from "../engine.js";
import type { Song } from "../layers.js";
import { type PlayOptions, play } from "../player.js";
import { isSong, refuseTiming, spokenLyrics, unsung } from "../song.js";
import type {
  Speaker,
  SpeakerSayOptions,
  SpeakerStreamOptions,
  SpokenPlayback,
  SpokenRendered,
  Supports,
} from "../speaker.js";
import {
  createKokoroVoice,
  KOKORO_SAMPLE_RATE,
  type KokoroSpeakOptions,
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
  singing: false,
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
export function lostFor(options?: SpeakerStreamOptions): string[] {
  const lost: string[] = [];
  if (options?.f0 !== undefined) lost.push("f0");
  if (options?.accent !== undefined) lost.push("accent");
  if (options?.body !== undefined) lost.push("body");
  if (options?.chunkSize !== undefined) lost.push("chunk size");
  return lost;
}

/**
 * A call's options as Kokoro takes them, and what it loses of them. A delivery's rate multiplies the
 * call's rate, or else the voice's own (`voiceRate`), as CHIMERA's does; the rest of it is lost.
 */
export function forKokoro(
  options: SpeakerStreamOptions = {},
  voiceRate?: number,
): { speak: KokoroSpeakOptions; lost: string[] } {
  const { delivery, intensity, ...rest } = options;
  const lost = lostFor(rest);
  const speak: KokoroSpeakOptions = {};
  if (rest.rate !== undefined) speak.rate = rest.rate;
  if (delivery === undefined) return { speak, lost };
  const d = atIntensity(delivery, intensity);
  if (d.rate !== undefined) speak.rate = (rest.rate ?? voiceRate ?? 1) * d.rate;
  return { speak, lost: [...lost, ...departures(d, ["rate"])] };
}

/** The text Kokoro speaks for a request, and what a song loses on the way: its notes. */
export function spoken(
  text: string | Song,
  options?: SpeakerStreamOptions,
): { words: string; lost: string[] } {
  if (!isSong(text)) return { words: text, lost: [] };
  refuseTiming("a song", options);
  return { words: spokenLyrics(text), lost: unsung(text) };
}

async function* chunksOf(
  voice: KokoroVoice,
  text: string | Iterable<string> | AsyncIterable<string>,
  options?: KokoroSpeakOptions,
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

    async render(text: string | Song, speakOptions?: SpeakerStreamOptions): Promise<SpokenRendered> {
      const { words, lost: notes } = spoken(text, speakOptions);
      const { speak, lost } = forKokoro(speakOptions, voice.rate);
      const rendered = await voice.render(words, speak);
      return { ...rendered, lost: [...notes, ...lost] };
    },

    async *stream(text: string | Song, speakOptions?: SpeakerStreamOptions) {
      const { words, lost: notes } = spoken(text, speakOptions);
      const { speak, lost } = forKokoro(speakOptions, voice.rate);
      for await (const chunk of voice.stream(words, speak)) yield chunk;
      return [...notes, ...lost];
    },

    say(text, speakOptions: SpeakerSayOptions = {}): SpokenPlayback {
      const { signal, context, destination, ...rest } = speakOptions;
      const playOptions: PlayOptions = {};
      if (context) playOptions.context = context;
      if (destination) playOptions.destination = destination;
      if (signal) playOptions.signal = signal;
      const song = isSong(text) ? spoken(text, rest) : undefined;
      const { speak, lost } = forKokoro(rest, voice.rate);
      const playback = play(
        chunksOf(voice, song?.words ?? (text as string), speak),
        KOKORO_SAMPLE_RATE,
        playOptions,
      );
      return {
        queued: playback.queued,
        done: playback.done.then(({ underruns }) => ({ underruns })),
        lost: song ? [...song.lost, ...lost] : lost,
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
