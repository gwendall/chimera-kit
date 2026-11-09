/**
 * What a speech engine must provide. The rest of the package only knows this file, so that the
 * engine can be replaced; `engines/` holds the implementations. Internal until a second engine
 * shows which parts of this are really common.
 */
import type { Score, Song } from "./layers.js";

/** Who speaks: a named body, or a blend (each weight from 0 to 1). */
export type Body = "male" | "female" | "child" | { female: number; child: number };

export interface SpeakOptions {
  body?: Body;
  /** Speaking-rate multiplier, above 1 is faster. Up to 4. */
  rate?: number;
  /** Baseline pitch in Hz. Defaults to the body's own. */
  f0?: number;
  /** Pitch excursion on stressed syllables, as a fraction. */
  accent?: number;
}

export interface EngineRequest extends SpeakOptions {
  text: string;
}

/** A song to plan, sung by a body. */
export interface SongRequest extends Song {
  body?: Body;
}

/** A score to render as an utterance (layer 2: exact timing and pitch, see `layers.ts`). */
export interface ScoreRequest {
  score: Score;
  body?: Body;
}

export interface EngineUtterance {
  /** The utterance's length in samples. */
  readonly samples: number;
  /** The next samples, at most `max`, or null when finished. Only valid until the next call. */
  next(max: number): Float32Array | null;
  free(): void;
}

export interface Engine {
  readonly sampleRate: number;
  /** The largest `max` that `EngineUtterance.next` honors. */
  readonly maxChunk: number;
  /** Plans an utterance. Throws an error with a readable message when it can't be spoken. */
  begin(request: EngineRequest): EngineUtterance;
  /**
   * Plans a request into a score instead of rendering it (layer 2 of `docs/design.md`). Only an
   * engine that computes a score internally implements this; others leave it undefined.
   */
  plan?(request: EngineRequest): Score;
  /**
   * Begins an utterance from a score, its timing and pitch honored exactly. Only an engine that
   * accepts a score implements this; others leave it undefined.
   */
  beginScore?(request: ScoreRequest): EngineUtterance;
  /** Plans a song into a score. Only an engine that sings implements this. */
  planSong?(request: SongRequest): Score;
  free(): void;
}
