/**
 * `intone/speaker`: one asynchronous interface every backend speaks through, so an app can switch
 * between CHIMERA (`createVoice`'s own engine), Kokoro (a neural model) and the device's own
 * voices (Web Speech) by changing one option, not its calls. See `docs/design.md`'s Engines
 * section for the design this follows.
 *
 * A separate entry from `intone` on purpose: `createSpeaker` can reach every backend, and Kokoro's
 * adapter pulls in `kokoro-js` (an optional peer dependency) the moment it is asked for. Importing
 * `intone` alone must never pull that in, so this factory, and the per-backend weight behind it,
 * live here instead. Each backend's adapter is loaded with a dynamic import, so a bundler keeps it
 * out of the chunk unless the app actually asks for that engine.
 *
 * No backend's name appears anywhere else in the package's public surface (`src/engines/<name>.ts`
 * is the one place each adapter is implemented): this file is the one place that picks between
 * them.
 */
import type { ChimeraSpeakerOptions } from "./engines/chimera-speaker.js";
import type { KokoroSpeakerOptions } from "./engines/kokoro-speaker.js";
import type { WebSpeechSpeakerOptions } from "./engines/web-speech-speaker.js";
import type { Song } from "./layers.js";
import type { PlayOptions } from "./player.js";
import type { Rendered, StreamOptions } from "./voice.js";
import type { DeliveryOptions } from "./worker-voice.js";

export type { Body, SpeakOptions } from "./engine.js";
export type { Note, Song } from "./layers.js";

/** The deepest layer the backend's own engine understands (`docs/design.md`'s layers 1 to 4). */
export type Layer = "intent" | "phrasing" | "score" | "gestures";

/** Samples the caller can play or save, or a playback the backend drives itself. */
export type Output = "samples" | "playback";

/** What a backend can represent of a delivery, regardless of any one call's request. */
export interface Supports {
  pitchCurve: boolean;
  soundTiming: boolean;
  breath: boolean;
  phones: boolean;
  /** BCP 47 tags, or a device-dependent backend's one matched voice. */
  langs: string[];
  /** Named bodies the backend can render directly, without approximating. */
  bodies: string[];
  /** Sings a song's notes. A backend that cannot speaks its lyrics, and says `notes` are lost. */
  singing: boolean;
}

export interface SpokenRendered extends Rendered {
  /** What this call asked for that the backend could not do. Empty when nothing was lost. */
  lost: string[];
}

/** How a spoken call ended. */
export interface SpokenEnd {
  /** Times the audio thread ran out of samples while it played. Absent when the backend can't
   * tell, such as the system voice, which plays outside the page. */
  underruns?: number;
}

export interface SpokenPlayback {
  /** Every sample that will play has reached the audio thread, or (`output: "playback"`) the
   * backend has been told to start. Resolves to nothing for a stopped call. */
  queued: Promise<void>;
  /** Speech has finished, or was stopped. */
  done: Promise<SpokenEnd>;
  /** What this call asked for that the backend could not do. Empty when nothing was lost. */
  lost: string[];
  stop(): void;
}

/**
 * A speaker's options are data, which every backend can read and a worker can receive: a delivery
 * comes as a mood or numbers, and each backend says in `lost` what of it it could not do. A `style`
 * is a function: give it to a page-thread voice (`createVoice`) instead.
 */
export type SpeakerStreamOptions = Omit<StreamOptions, "style" | "airway"> & DeliveryOptions;

export interface SpeakerSayOptions extends SpeakerStreamOptions, Omit<PlayOptions, "ahead"> {}

/** The unified shape every backend's open voice presents. */
export interface Speaker {
  /** Which backend this is; the one place a caller may need to know, for a capability check. */
  readonly id: EngineName;
  readonly accepts: Layer;
  readonly supports: Supports;
  readonly output: Output;
  /** Only set when `output` is `"samples"`. */
  readonly sampleRate?: number;
  /** Renders the whole utterance at once. Only present when `output` is `"samples"`. */
  render?(text: string | Song, options?: SpeakerStreamOptions): Promise<SpokenRendered>;
  /**
   * Renders chunk by chunk. Only present when `output` is `"samples"`. The generator's return
   * value is `lost`; a `for await` loop drops it, so read it from a manual `.next()` call when it
   * matters.
   */
  stream?(
    text: string | Song,
    options?: SpeakerStreamOptions,
  ): AsyncGenerator<Float32Array, string[], undefined>;
  /**
   * Speaks aloud. A string or a song is one utterance; pieces of text that are still arriving (a
   * language model's tokens) are spoken clause by clause, Markdown read as words. A song refuses
   * `rate`, `f0` and `accent` on every backend, as its notes set them.
   */
  say(
    text: string | Song | Iterable<string> | AsyncIterable<string>,
    options?: SpeakerSayOptions,
  ): SpokenPlayback;
  /** Releases the backend's resources. It can't be used afterwards. */
  free(): void;
}

export type EngineName = "chimera" | "kokoro" | "web-speech";

interface SpeakerOptionsFor {
  chimera: ChimeraSpeakerOptions;
  kokoro: KokoroSpeakerOptions;
  "web-speech": WebSpeechSpeakerOptions;
}

const ENGINES = ["chimera", "kokoro", "web-speech"] as const;

/**
 * Opens a backend behind the shared `Speaker` interface. Defaults to `"chimera"`, this package's
 * own engine; `"kokoro"` needs `kokoro-js` and `@huggingface/transformers` installed (they are
 * optional peer dependencies, and the model downloads on first use); `"web-speech"` needs a
 * browser's `speechSynthesis`.
 */
export async function createSpeaker<E extends EngineName = "chimera">(
  engine?: E,
  options?: SpeakerOptionsFor[E],
): Promise<Speaker> {
  const chosen = engine ?? "chimera";
  switch (chosen) {
    case "chimera":
      return (await import("./engines/chimera-speaker.js")).createChimeraSpeaker(
        options as ChimeraSpeakerOptions,
      );
    case "kokoro":
      return (await import("./engines/kokoro-speaker.js")).createKokoroSpeaker(
        options as KokoroSpeakerOptions,
      );
    case "web-speech":
      return (await import("./engines/web-speech-speaker.js")).createWebSpeechSpeaker(
        options as WebSpeechSpeakerOptions,
      );
    default:
      throw new RangeError(`intone: no engine "${chosen}". Engines: ${ENGINES.join(", ")}`);
  }
}
