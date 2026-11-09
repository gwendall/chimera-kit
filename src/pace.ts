/**
 * Clauses spoken one after the other, with the pauses the whole text would have had. The engine
 * ends every utterance on about 230 ms of silence, whatever its last mark; inside one utterance it
 * pauses about 140 ms at a comma and 300 ms at the end of a sentence. Spoken apart, commas dragged
 * and sentences ran into each other.
 */
import { type ClauseOptions, clauses } from "./clauses.js";
import type { StreamOptions, Voice } from "./voice.js";

/** Below this, a sample is silence: -50 dBFS. */
const QUIET = 10 ** (-50 / 20);

/** Seconds of silence after a clause at rate 1: a sentence's end, or anything shorter. */
export function pauseAfter(clause: string): number {
  const mark = clause.replace(/["')\]\u201d\u2019\s]+$/, "").slice(-1);
  return /[.!?\u2026]/.test(mark) ? 0.3 : 0.14;
}

/**
 * The chunks of one utterance, its trailing silence made exactly `pause` samples long: cut, or
 * padded with zeros. Every chunk but the last loud one passes unchanged and on time; that one waits
 * for the next loud chunk or the end, so its tail can be cut.
 */
export function* withPause(
  chunks: Iterable<Float32Array>,
  pause: number,
): Generator<Float32Array, void, undefined> {
  let loud: Float32Array | undefined;
  let quiet: Float32Array[] = [];
  for (const chunk of chunks) {
    if (lastLoud(chunk) < 0) {
      quiet.push(chunk);
      continue;
    }
    if (loud) yield loud;
    yield* quiet;
    quiet = [];
    loud = chunk;
  }
  // Lengths are read before each yield: a consumer may transfer the chunk, which empties it.
  let left = pause;
  if (loud) {
    const end = lastLoud(loud) + 1;
    const tail = loud.length - end;
    if (tail >= left) {
      yield loud.slice(0, end + left);
      return;
    }
    left -= tail;
    yield loud;
  }
  for (const chunk of quiet) {
    if (left === 0) return;
    const part = chunk.length <= left ? chunk : chunk.slice(0, left);
    left -= part.length;
    yield part;
  }
  if (left > 0) yield new Float32Array(left);
}

function lastLoud(chunk: Float32Array): number {
  for (let i = chunk.length - 1; i >= 0; i--) if (Math.abs(chunk[i] as number) >= QUIET) return i;
  return -1;
}

export interface SpeechOptions extends StreamOptions {
  /** How text that arrives in pieces is cut into clauses. */
  clauses?: ClauseOptions;
}

/**
 * Speaks text, or text that is still arriving (a language model's tokens), clause by clause: each
 * clause is computed while the one before it plays, and paused after as its last mark asks.
 */
export async function* speech(
  voice: Voice,
  text: string | Iterable<string> | AsyncIterable<string>,
  options: SpeechOptions = {},
): AsyncGenerator<Float32Array, void, undefined> {
  const { clauses: cutting, ...speak } = options;
  // A string is one utterance, paused inside by the engine itself.
  const pieces = typeof text === "string" ? [text] : clauses(text, cutting);
  for await (const clause of pieces) {
    yield* pacedClause(voice, clause, speak);
  }
}

/** One clause's chunks, its pause set by its last mark and the rate. */
export function pacedClause(
  voice: Voice,
  clause: string,
  options: StreamOptions = {},
): Generator<Float32Array> {
  const pause = Math.round((voice.sampleRate * pauseAfter(clause)) / (options.rate ?? 1));
  return withPause(voice.stream(clause, options), pause);
}
