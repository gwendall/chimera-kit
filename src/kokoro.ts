/**
 * `intone/kokoro`: the Kokoro TTS backend (`kokoro-js`, an 82M-parameter neural model), as a
 * separate entry so that `kokoro-js` and its model never reach anyone who only imports `intone`.
 * See `docs/design.md`'s Packaging section and `src/engines/kokoro.ts` for the adapter itself.
 *
 * `kokoro-js` is an optional peer dependency: install it yourself (`bun add kokoro-js
 * @huggingface/transformers`) before importing this entry. `createKokoroVoice` downloads the
 * model (tens to hundreds of MB, by `dtype`) from Hugging Face on first use and caches it; see
 * `KokoroVoiceOptions` for where that download goes.
 */

export {
  createKokoroVoice,
  KOKORO_SAMPLE_RATE,
  type KokoroRendered,
  type KokoroRenderedScore,
  type KokoroSpeakOptions,
  type KokoroVoice,
  type KokoroVoiceOptions,
} from "./engines/kokoro.js";
export type { KokoroDevice, KokoroDtype } from "./engines/kokoro-options.js";
export {
  type EncodedPhones,
  encodeSoundsForKokoro,
  UNMAPPED_PHONES,
} from "./engines/kokoro-phones.js";
