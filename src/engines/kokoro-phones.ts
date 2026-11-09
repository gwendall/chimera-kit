/**
 * Maps CHIMERA's IPA phones (what `Score.sounds` holds, see `../layers.ts`) to the Kokoro model's
 * token ids, so a score can be spoken through `KokoroTTS.generate_from_ids` instead of Kokoro's
 * own text-to-phoneme step. Pure and synchronous: no model, no `kokoro-js` import, so it can be
 * tested and used without the model download.
 *
 * Kokoro's tokenizer (`src/engines/kokoro-vocab.generated.json`, from the model's
 * `tokenizer.json`, see `scripts/gen-kokoro-vocab.ts`) is a char-level `WordLevel` vocabulary: one
 * token per IPA character, no merges, no subwords. Every input is wrapped in the pad token `"$"`
 * (id 0) at both ends (confirmed from `tokenizer.json`'s `post_processor`, and from running the
 * real tokenizer: `tokenizer("bˈɜːd")` gives `[0, 44, 156, 87, 158, 46, 0]`).
 *
 * The mapping below was checked two ways: every CHIMERA phone against the vocabulary's character
 * set (`bun run -e` over the two source tables), and the three phones with no single matching
 * character against real output of `phonemizer` (the espeak-ng binding `kokoro-js` itself uses)
 * on English words that contain them ("bird", "water", "go").
 */

import type { Sound, WordSpan } from "../layers.js";
import kokoroVocab from "./kokoro-vocab.generated.json" with { type: "json" };

/** Character to Kokoro token id, from the model's tokenizer. */
export const VOCAB: Readonly<Record<string, number>> = kokoroVocab;

/** Start and end of every sequence (the tokenizer's `pad_token`/`unk_token`, both `"$"`). */
export const BOS_EOS_ID = 0;

/** Primary and secondary stress, placed immediately before the vowel they mark. */
const STRESS_1 = "ˈ";
const STRESS_2 = "ˌ";

/**
 * CHIMERA phone (IPA, as emitted by `crates/chimera/src/phonetics/english.rs` and the broader
 * inventory in `inventory.rs`/`ipa.rs`) to the Kokoro token characters that stand for it.
 *
 * Three entries are not the phone's own character:
 * - `"g"` (ASCII U+0067, what CHIMERA writes) is not in Kokoro's vocabulary at all; only the IPA
 *   script g, `"ɡ"` (U+0261, visually near-identical), is. Easy to miss, since the two render the
 *   same in most fonts.
 * - `"ɝ"` (stressed r-coloured vowel) has no token. Kokoro's own espeak pipeline never emits it
 *   either: "bird" phonemizes to `bˈɜːd`, long `ɜ` plus the unstressed-pair's vowel, not a dedicated
 *   rhotic symbol. Mapped to `"ɜː"` (two tokens) to match.
 * - `"ɫ"` (dark/velarised l, CHIMERA's coda allophone) has no token; Kokoro has only plain `"l"`.
 *   The velarisation is acoustic, not phonemic, in this vocabulary, matching `"ɬ" -> "l"` in
 *   `kokoro-js`'s own post-processing of espeak output.
 *
 * `"ʀ"` (uvular trill) and `"ʙ"` (bilabial trill) also have no token; mapped to the closest
 * available consonant (losing the trill) rather than left unmapped, but still reported in `lost`.
 */
const PHONE_TOKENS: Readonly<Record<string, string>> = {
  // vowels (English inventory, english.rs `VOWELS`)
  ɑ: "ɑ",
  æ: "æ",
  ʌ: "ʌ",
  ə: "ə",
  ɔ: "ɔ",
  aʊ: "aʊ",
  aɪ: "aɪ",
  ɛ: "ɛ",
  ɝ: "ɜː", // no direct token; matches Kokoro's own espeak output for stressed rhotic vowels
  ɚ: "ɚ",
  eɪ: "eɪ",
  ɪ: "ɪ",
  i: "i",
  oʊ: "oʊ",
  ɔɪ: "ɔɪ",
  ʊ: "ʊ",
  u: "u",
  // consonants (English inventory + allophones ɾ, ɫ)
  b: "b",
  tʃ: "tʃ",
  d: "d",
  ð: "ð",
  f: "f",
  g: "ɡ", // ASCII g has no token; the vocabulary only has IPA script g (U+0261)
  h: "h",
  dʒ: "dʒ",
  k: "k",
  l: "l",
  ɫ: "l", // dark l: no token, acoustic-only distinction in this vocabulary
  m: "m",
  n: "n",
  ŋ: "ŋ",
  p: "p",
  ɹ: "ɹ",
  s: "s",
  ʃ: "ʃ",
  t: "t",
  ɾ: "ɾ",
  θ: "θ",
  v: "v",
  w: "w",
  j: "j",
  z: "z",
  ʒ: "ʒ",
};

/**
 * The rest of CHIMERA's inventory (`crates/chimera/src/phonetics/inventory.rs` consonants and
 * `ipa.rs`'s `VOWEL_CHARS`/`MULTI`) that are not part of the English set above but still map to a
 * real Kokoro token or a defensible substitute. Phones with truly no equivalent are left out and
 * fall back to `UNMAPPED_FALLBACK` at encode time, landing in `lost`.
 */
const EXTENDED_PHONE_TOKENS: Readonly<Record<string, string>> = {
  t: "t",
  d: "d",
  ʈ: "ʈ",
  ɖ: "ɖ",
  c: "c",
  ɟ: "ɟ",
  k: "k",
  q: "q",
  ʔ: "ʔ",
  m: "m",
  ɳ: "ɳ",
  ɲ: "ɲ",
  ɴ: "ɴ",
  ɸ: "ɸ",
  β: "β",
  s: "s",
  z: "z",
  ʂ: "ʂ",
  ç: "ç",
  ʝ: "ʝ",
  x: "k", // no token; kokoro-js's own espeak post-processing also folds x -> k
  ɣ: "ɣ",
  χ: "χ",
  ʁ: "ʁ",
  ɦ: "h", // no token for breathy voice; nearest is plain h, losing the voicing
  ɬ: "l", // no token; matches kokoro-js's own `ɬ -> l`
  ts: "ts",
  dz: "dz",
  pf: "pf",
  w: "w",
  ʋ: "ʋ",
  ɻ: "ɻ",
  j: "j",
  ɰ: "ɰ",
  l: "l",
  ɭ: "l", // no token for retroflex lateral; nearest is plain l
  ʎ: "ʎ",
  ɽ: "ɽ",
  r: "r",
  ʀ: "r", // no token for uvular trill; nearest available trill is plain r
  ʙ: "b", // no token for bilabial trill; nearest is plain b, losing the trill
  y: "y",
  ɨ: "ɨ",
  ɯ: "ɯ",
  ʏ: "ʊ", // no token; nearest rounded high front-ish vowel available
  e: "e",
  ø: "ø",
  o: "o",
  œ: "œ",
  ɜ: "ɜ",
  ʌ: "ʌ",
  æ: "æ",
  ɐ: "ɐ",
  a: "a",
  ɑ: "ɑ",
  ɒ: "ɒ",
};

/**
 * CHIMERA phones with no reasonable Kokoro token, substitute or otherwise: `ħ`, `ʕ` (pharyngeals),
 * `ɢ` (voiced uvular stop), `ɱ` (labiodental nasal), `ɮ` (voiced lateral fricative), `ɘ ɵ ɞ ɶ ʉ`
 * (central/rounded vowels outside the English set), and `ʐ` (voiced retroflex fricative, despite
 * `ʂ` its voiceless counterpart having one). Encoding one of these falls back to a schwa and the
 * phone is reported in `lost`.
 */
export const UNMAPPED_PHONES: ReadonlySet<string> = new Set([
  "ħ",
  "ʕ",
  "ɢ",
  "ɱ",
  "ɮ",
  "ɘ",
  "ɵ",
  "ɞ",
  "ɶ",
  "ʉ",
  "ʐ",
]);

/** Used for a phone with no mapping at all, so the token stream stays well-formed. */
const UNMAPPED_FALLBACK = "ə";

/** All tokens accounted for: English phones take priority over the extended table. */
function tokensFor(phone: string): string | undefined {
  return PHONE_TOKENS[phone] ?? (UNMAPPED_PHONES.has(phone) ? undefined : EXTENDED_PHONE_TOKENS[phone]);
}

/** A single character's token id, or `undefined` if the vocabulary doesn't have it. */
export function charToId(ch: string): number | undefined {
  return VOCAB[ch];
}

export interface EncodedPhones {
  /** Ready for `generate_from_ids`: wrapped in the pad token, one id per character. */
  ids: number[];
  /** Phones from the score with no Kokoro equivalent, deduplicated, in first-seen order. */
  lost: string[];
}

/**
 * Encodes a score's sounds (and, if given, its word spans, to place the spaces Kokoro's own
 * tokenizer would have) as Kokoro token ids for `generate_from_ids`.
 *
 * `"_"` (silence) has no token: it becomes a comma for a short gap or a period for one at least
 * 0.3 s, Kokoro's own cues for a pause. The requested duration itself is lost either way, since
 * Kokoro has no timing input; see `lost`.
 *
 * Stress is placed right before the vowel it marks, not before the syllable's onset consonants as
 * espeak does: the score has no syllable boundaries to place it at. `words` is needed to emit
 * spaces between words; without it every phone runs together as the model's eye, and `"word
 * boundaries"` is reported in `lost`.
 */
export function encodeSoundsForKokoro(sounds: readonly Sound[], words?: readonly WordSpan[]): EncodedPhones {
  const lost = new Set<string>();
  const ids: number[] = [BOS_EOS_ID];
  // Word starts after the first, in time order, so a space can be inserted at each one.
  const wordStarts = words && words.length > 0 ? new Set(words.slice(1).map((w) => w.t0)) : null;
  if (!words || words.length === 0) lost.add("word boundaries");

  const pushChar = (ch: string): void => {
    const id = VOCAB[ch];
    if (id === undefined) {
      lost.add(`vocabulary gap: ${JSON.stringify(ch)}`);
      return;
    }
    ids.push(id);
  };

  for (const sound of sounds) {
    if (wordStarts?.has(sound.t0)) pushChar(" ");

    if (sound.sound === "_") {
      pushChar(sound.t1 - sound.t0 >= 0.3 ? "." : ",");
      continue;
    }

    const tokens = tokensFor(sound.sound);
    if (tokens === undefined) {
      lost.add(sound.sound);
      pushChar(UNMAPPED_FALLBACK);
      continue;
    }
    if (sound.stress === 1) pushChar(STRESS_1);
    else if (sound.stress === 2) pushChar(STRESS_2);
    for (const ch of tokens) pushChar(ch);
  }

  ids.push(BOS_EOS_ID);
  return { ids, lost: [...lost] };
}
