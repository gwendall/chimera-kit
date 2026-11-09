# Changes to the engine

`crates/chimera` is CHIMERA, kept as a git subtree of
[jamesondh/chimera-vocal-synth](https://github.com/jamesondh/chimera-vocal-synth). It is changed
here only when the intelligibility harness (`eval/`) shows the engine is at fault, one change at a
time, and each change is meant to be offered upstream. `bun run sync-upstream` merges upstream work
over these; a conflict on a file listed here means upstream touched the same lines.

## 1. Function words keep their dictionary vowel

`crates/chimera/src/phonetics/english.rs`, `EnglishG2P::word`.

**What upstream does.** In running text, a monosyllabic function word ("of", "and", "that", "but")
is unstressed, and its vowel is rewritten toward schwa (`reduce_vowel`: /ʌ æ ɑ ɛ ɔ u ʊ/ become /ə/).

**What goes wrong.** Both recognizers hear the rewritten words as other words: "and" as "into",
"that" as "to". The rewrite stacks on top of CMUdict, whose entries for these words are often
already the reduced running-speech form: its "and" is `AH0 N D`, /ʌnd/, not /ænd/.

**The change.** Function words are still unstressed, for timing and pitch, but keep their
dictionary vowel; `reduce_vowel` is gone. "and" takes its citation form, `AE1 N D`, through a
`full_form` table read before the dictionary.

**Measured** (word errors, `eval/run.ts`, two voices, judge 1):

| Step                           | Parakeet dev | Whisper dev |
| ------------------------------ | ------------ | ----------- |
| Before                         | 46.22 %      | 26.38 %     |
| No rewrite toward schwa        | 44.64 %      | 24.18 %     |
| And "and" in its citation form | 42.62 %      | 22.83 %     |

Held-out sentences, same change: Parakeet 46.94 % to 42.81 %, Whisper 26.50 % to 23.71 %. No split
of either recognizer got worse.

**Not measured.** Naturalness: reduced function words are how people speak, and a recognizer
rewards the citation form. A listening test could show the change costs some fluency. Singing
(`plan_song`) goes through the same function and was not evaluated.
