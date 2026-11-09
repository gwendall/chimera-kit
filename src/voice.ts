import type { Engine, EngineUtterance, SpeakOptions } from "./engine.js";
import type { Score } from "./layers.js";

/** One audio-worklet quantum: 2.7 ms of audio, so that the first sound leaves as soon as it exists. */
const DEFAULT_CHUNK = 128;

export interface StreamOptions extends SpeakOptions {
  /** Samples per chunk, from 1 to 4096. Defaults to 128 (2.7 ms of audio). */
  chunkSize?: number;
}

export interface Rendered {
  /** Mono samples, nominally within -1 to 1. */
  audio: Float32Array;
  sampleRate: number;
}

/** Text, or a score whose timing and pitch are honored exactly instead of planned afresh. */
export type Speakable = string | Score;

export interface Voice {
  readonly sampleRate: number;
  /** Plans text into a score (layer 2 of `docs/design.md`) without rendering it. */
  plan(text: string, options?: SpeakOptions): Score;
  /** Renders the whole utterance at once. */
  render(input: Speakable, options?: SpeakOptions): Rendered;
  /** Renders chunk by chunk. Each chunk is a fresh array the caller owns. */
  stream(input: Speakable, options?: StreamOptions): Generator<Float32Array, void, undefined>;
  /** Releases the voice's memory. It can't be used afterwards. */
  free(): void;
}

/** A voice speaking through an engine. Owns the engine from here on. */
export function voiceFrom(engine: Engine, defaults: SpeakOptions = {}): Voice {
  return new EngineVoice(engine, defaults);
}

class EngineVoice implements Voice {
  private freed = false;

  constructor(
    private readonly engine: Engine,
    private readonly defaults: SpeakOptions,
  ) {}

  get sampleRate(): number {
    return this.engine.sampleRate;
  }

  plan(text: string, options?: SpeakOptions): Score {
    if (this.freed) throw new Error("intone: this voice has been freed");
    if (!this.engine.plan) throw new Error("intone: this engine cannot plan a score");
    return this.engine.plan({ ...this.defaults, ...options, text });
  }

  render(input: Speakable, options?: SpeakOptions): Rendered {
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

  private begin(input: Speakable, options?: SpeakOptions): EngineUtterance {
    if (this.freed) throw new Error("intone: this voice has been freed");
    if (typeof input === "string") {
      return this.engine.begin({ ...this.defaults, ...options, text: input });
    }
    if (!this.engine.beginScore) throw new Error("intone: this engine cannot render a score");
    // A score already holds its timing and pitch: changing them is a transform, not an option.
    const refused = (["rate", "f0", "accent"] as const).filter((key) => options?.[key] !== undefined);
    if (refused.length > 0) {
      throw new RangeError(
        `intone: a score ignores ${refused.join(", ")}; transform it instead (stretch, shift, deliver)`,
      );
    }
    const body = options?.body ?? this.defaults.body;
    return this.engine.beginScore(body === undefined ? { score: input } : { score: input, body });
  }
}
