import type { Engine, EngineUtterance, SpeakOptions } from "./engine.js";

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

export interface Voice {
  readonly sampleRate: number;
  /** Renders the whole utterance at once. */
  render(text: string, options?: SpeakOptions): Rendered;
  /** Renders chunk by chunk. Each chunk is a fresh array the caller owns. */
  stream(text: string, options?: StreamOptions): Generator<Float32Array, void, undefined>;
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

  render(text: string, options?: SpeakOptions): Rendered {
    const { maxChunk } = this.engine;
    const utterance = this.begin(text, options);
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

  *stream(text: string, options: StreamOptions = {}): Generator<Float32Array, void, undefined> {
    const { maxChunk } = this.engine;
    const { chunkSize = DEFAULT_CHUNK, ...speak } = options;
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > maxChunk) {
      throw new RangeError(`intone: chunkSize must be from 1 to ${maxChunk}, got ${chunkSize}`);
    }
    const utterance = this.begin(text, speak);
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

  private begin(text: string, options?: SpeakOptions): EngineUtterance {
    if (this.freed) throw new Error("intone: this voice has been freed");
    return this.engine.begin({ ...this.defaults, ...options, text });
  }
}
