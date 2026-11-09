/**
 * intone: text to speech from a simulated airway, in about a megabyte.
 *
 * The API speaks of voices and utterances. The engine behind it is an implementation detail.
 */
import { type ChimeraSources, loadChimera } from "./engines/chimera.js";
import { type Voice, type VoiceOptions, voiceFrom } from "./voice.js";

export type { Body, SpeakOptions } from "./engine.js";
export type { Source } from "./engines/chimera.js";
export type {
  Curve,
  Note,
  Phrase,
  PhraseEnd,
  Phrasing,
  Score,
  Song,
  Sound,
  Syllable,
  Word,
  WordSpan,
} from "./layers.js";
export type { Rendered, Speakable, StreamOptions, Voice, VoiceOptions } from "./voice.js";

export interface CreateVoiceOptions extends VoiceOptions, ChimeraSources {}

/** Loads the engine and returns a voice. */
export async function createVoice(options: CreateVoiceOptions = {}): Promise<Voice> {
  const { wasm, dictionary, ...defaults } = options;
  const sources: ChimeraSources = {};
  if (wasm !== undefined) sources.wasm = wasm;
  if (dictionary !== undefined) sources.dictionary = dictionary;
  return voiceFrom(await loadChimera(sources), defaults);
}

export { ClauseCutter, type ClauseOptions, clauses, speakable } from "./clauses.js";
export { blend, type Delivery, deliver, MOODS, type Mood } from "./delivery.js";
export { pauseAfter, type SpeechOptions, speech, withPause } from "./pace.js";
export { type Playback, type PlaybackEnd, type PlayOptions, play, unlockAudio } from "./player.js";
export { Selection, Take, take } from "./take.js";
export type { ScoreTransform, Span } from "./transforms.js";
export {
  breathier,
  compose,
  EMPHASIS,
  emphasize,
  gain,
  parseInterval,
  pauseAt,
  pauses,
  RAMP,
  range,
  rate,
  shift,
  stretch,
  tenser,
  valueAt,
} from "./transforms.js";
export {
  type AsyncVoice,
  createWorkerVoice,
  type SayOptions,
  type WorkerStreamOptions,
  type WorkerVoiceOptions,
} from "./worker-voice.js";
