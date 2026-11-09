/**
 * A hand-built `Score` for "The birch canoe slid on the smooth planks." (one of the three Harvard
 * sentences `scripts/kokoro-check.ts` renders), used to exercise `renderScore`'s phoneme path
 * without a full English front end. Phones are IPA, matching CHIMERA's output
 * (`crates/chimera/src/phonetics/english.rs`); timings are schematic (not measured), just enough
 * to give every sound and word a distinct, time-ordered span.
 */

import type { Score, Sound, WordSpan } from "../layers.js";

/** One word's phones, with lexical stress on its vowel(s) (1 primary, 0 elsewhere). */
const WORDS: { text: string; phones: [sound: string, stress?: 0 | 1 | 2][] }[] = [
  { text: "The", phones: [["ð"], ["ə"]] },
  { text: "birch", phones: [["b"], ["ɝ", 1], ["tʃ"]] },
  { text: "canoe", phones: [["k"], ["ə"], ["n"], ["u", 1]] },
  { text: "slid", phones: [["s"], ["l"], ["ɪ", 1], ["d"]] },
  { text: "on", phones: [["ɑ", 1], ["n"]] },
  { text: "the", phones: [["ð"], ["ə"]] },
  { text: "smooth", phones: [["s"], ["m"], ["u", 1], ["ð"]] },
  { text: "planks", phones: [["p"], ["l"], ["æ", 1], ["ŋ"], ["k"], ["s"]] },
];

const CONSONANT_DURATION = 0.08;
const VOWEL_DURATION = 0.12;
const WORD_GAP = 0.05;

function duration(sound: string): number {
  return /[ɝəuɪɑæ]/.test(sound) ? VOWEL_DURATION : CONSONANT_DURATION;
}

/** Builds the sounds and word spans, leaving a short silence between words. */
function build(): { sounds: Sound[]; words: WordSpan[] } {
  const sounds: Sound[] = [];
  const words: WordSpan[] = [];
  let t = 0;
  for (const [wordIndex, word] of WORDS.entries()) {
    if (wordIndex > 0) {
      sounds.push({ sound: "_", t0: t, t1: t + WORD_GAP });
      t += WORD_GAP;
    }
    const wordStart = t;
    for (const [sound, stress] of word.phones) {
      const t1 = t + duration(sound);
      sounds.push(stress === undefined ? { sound, t0: t, t1 } : { sound, t0: t, t1, stress });
      t = t1;
    }
    words.push({ text: word.text, t0: wordStart, t1: t });
  }
  return { sounds, words };
}

/** A gently falling pitch, typical of a plain statement: 120 Hz down to 90 Hz. */
function fallingPitch(totalDuration: number): Score["pitch"] {
  return [
    [0, 120],
    [totalDuration, 90],
  ];
}

export function birchCanoeScore(): Score {
  const { sounds, words } = build();
  const total = (sounds.at(-1)?.t1 ?? 0) + 0.1; // trailing silence
  return { duration: total, sounds, pitch: fallingPitch(total), words };
}
