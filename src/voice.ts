import type { Engine, EngineUtterance, SpeakOptions } from "./engine.js";
import type { Score, Song } from "./layers.js";
import { isSong, refuseTiming } from "./song.js";
import type { ScoreTransform } from "./transforms.js";

/** One audio-worklet quantum: 2.7 ms of audio, so that the first sound leaves as soon as it exists. */
const DEFAULT_CHUNK = 128;

export interface VoiceOptions extends SpeakOptions {
  /**
   * Applied to every score planned from text, such as `deliver("calm")` or a `compose` of
   * transforms. Text with a style is planned, transformed and rendered as a score; a score passed
   * in takes only the style given with that call, as the voice's own is already in it when it came
   * from `plan`.
   */
  style?: ScoreTransform;
}

export interface StreamOptions extends VoiceOptions {
  /** Samples per chunk, from 1 to 4096. Defaults to 128 (2.7 ms of audio). */
  chunkSize?: number;
}

export interface Rendered {
  /** Mono samples, nominally within -1 to 1. */
  audio: Float32Array;
  sampleRate: number;
}

/**
 * Text; a song, sung on its notes; or a score, whose timing and pitch are honored exactly instead
 * of planned afresh.
 */
export type Speakable = string | Song | Score;

export interface Voice {
  readonly sampleRate: number;
  /**
   * Plans text or a song into a score (layer 2 of `docs/design.md`) without rendering it. A song,
   * like a score, takes only the style given with that call, and refuses `rate`, `f0` and `accent`:
   * its notes set them.
   */
  plan(input: string | Song, options?: VoiceOptions): Score;
  /** Renders the whole utterance at once. */
  render(input: Speakable, options?: VoiceOptions): Rendered;
  /** Renders chunk by chunk. Each chunk is a fresh array the caller owns. */
  stream(input: Speakable, options?: StreamOptions): Generator<Float32Array, void, undefined>;
  /** Releases the voice's memory. It can't be used afterwards. */
  free(): void;
}

/** A voice speaking through an engine. Owns the engine from here on. */
export function voiceFrom(engine: Engine, defaults: VoiceOptions = {}): Voice {
  return new EngineVoice(engine, defaults);
}

class EngineVoice implements Voice {
  private freed = false;

  constructor(
    private readonly engine: Engine,
    private readonly defaults: VoiceOptions,
  ) {}

  get sampleRate(): number {
    return this.engine.sampleRate;
  }

  plan(input: string | Song, options?: VoiceOptions): Score {
    if (this.freed) throw new Error("intone: this voice has been freed");
    if (typeof input !== "string") {
      if (!this.engine.planSong) throw new Error("intone: this engine cannot sing");
      refuseTiming("a song", options);
      const body = options?.body ?? this.defaults.body;
      const score = this.engine.planSong(body === undefined ? input : { ...input, body });
      return options?.style ? options.style(score) : score;
    }
    if (!this.engine.plan) throw new Error("intone: this engine cannot plan a score");
    const { style, ...speak } = { ...this.defaults, ...options };
    const score = this.engine.plan({ ...speak, text: input });
    return style ? style(score) : score;
  }

  render(input: Speakable, options?: VoiceOptions): Rendered {
    const { maxChunk } = this.engine;
    const utterance = this.begin(input, options);
    try {
      const audio = new Float32Array(utterance.samples);
      let at = 0;
      for (let chunk = utterance.next(maxChunk); chunk; chunk = utterance.next(maxChunk)) {
        audio.set(chunk, at);
        at += chunk.length;
      }
      return { audio, sampleRate: this.sampleRate };
    } finally {
      utterance.free();
    }
  }

  *stream(input: Speakable, options: StreamOptions = {}): Generator<Float32Array, void, undefined> {
    const { maxChunk } = this.engine;
    const { chunkSize = DEFAULT_CHUNK, ...speak } = options;
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > maxChunk) {
      throw new RangeError(`intone: chunkSize must be from 1 to ${maxChunk}, got ${chunkSize}`);
    }
    const utterance = this.begin(input, speak);
    try {
      for (let chunk = utterance.next(chunkSize); chunk; chunk = utterance.next(chunkSize)) {
        yield chunk.slice();
      }
    } finally {
      utterance.free();
    }
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.engine.free();
  }

  private begin(input: Speakable, options?: VoiceOptions): EngineUtterance {
    if (this.freed) throw new Error("intone: this voice has been freed");
    if (typeof input === "string") {
      const { style, ...speak } = { ...this.defaults, ...options };
      // Without a style, text goes straight to the engine, sample for sample as before.
      if (!style) return this.engine.begin({ ...speak, text: input });
      if (!this.engine.beginScore) throw new Error("intone: this engine cannot render a score");
      const score = this.plan(input, options);
      return this.engine.beginScore(speak.body === undefined ? { score } : { score, body: speak.body });
    }
    if (!this.engine.beginScore) throw new Error("intone: this engine cannot render a score");
    let score: Score;
    if (isSong(input)) score = this.plan(input, options);
    else {
      refuseTiming("a score", options);
      score = options?.style ? options.style(input) : input;
    }
    const body = options?.body ?? this.defaults.body;
    return this.engine.beginScore(body === undefined ? { score } : { score, body });
  }
}
