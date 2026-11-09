/**
 * intone: text to speech from a simulated airway, in about a megabyte.
 *
 * The API speaks of voices and utterances. The engine behind it is an implementation detail.
 */
import type { SpeakOptions } from "./engine.js";
import { type ChimeraSources, loadChimera } from "./engines/chimera.js";
import { type Voice, voiceFrom } from "./voice.js";

export type { Body, SpeakOptions } from "./engine.js";
export type { Source } from "./engines/chimera.js";
export type { Rendered, StreamOptions, Voice } from "./voice.js";

export interface CreateVoiceOptions extends SpeakOptions, ChimeraSources {}

/** Loads the engine and returns a voice. */
export async function createVoice(options: CreateVoiceOptions = {}): Promise<Voice> {
  const { wasm, dictionary, ...defaults } = options;
  const sources: ChimeraSources = {};
  if (wasm !== undefined) sources.wasm = wasm;
  if (dictionary !== undefined) sources.dictionary = dictionary;
  return voiceFrom(await loadChimera(sources), defaults);
}
