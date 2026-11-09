#!/usr/bin/env bun
/**
 * Regenerates `src/engines/kokoro-vocab.generated.json`: the character to token id table of the
 * Kokoro model's tokenizer (a char-level `WordLevel` vocab, confirmed from `tokenizer.json`'s
 * `pre_tokenizer` splitting on every character and `post_processor` wrapping each sequence in the
 * pad token `"$"`, id 0, at both ends).
 *
 * Never edited by hand: rerun this after bumping the Kokoro model id, which is the only thing
 * that can change the vocabulary.
 *
 *   bun scripts/gen-kokoro-vocab.ts
 */
import { join } from "node:path";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const OUT = join(import.meta.dir, "../src/engines/kokoro-vocab.generated.json");

const url = `https://huggingface.co/${MODEL_ID}/resolve/main/tokenizer.json`;
const response = await fetch(url);
if (!response.ok) throw new Error(`gen-kokoro-vocab: ${url} answered ${response.status}`);
const tokenizer = (await response.json()) as { model: { vocab: Record<string, number> } };
const vocab = tokenizer.model.vocab;

const sorted = Object.fromEntries(Object.entries(vocab).sort(([, a], [, b]) => a - b));
await Bun.write(OUT, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`gen-kokoro-vocab: wrote ${Object.keys(sorted).length} entries to ${OUT}`);
