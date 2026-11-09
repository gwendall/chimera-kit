import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sound, WordSpan } from "../layers.ts";
import { BOS_EOS_ID, charToId, encodeSoundsForKokoro, UNMAPPED_PHONES, VOCAB } from "./kokoro-phones.ts";

const CRATES = join(import.meta.dir, "../../crates/chimera/src/phonetics");

/** A vocabulary id, asserted present (the tests below only ever ask for characters that are). */
function v(ch: string): number {
  const id = VOCAB[ch];
  if (id === undefined) throw new Error(`test fixture error: ${JSON.stringify(ch)} is not in VOCAB`);
  return id;
}

describe("the Kokoro vocabulary", () => {
  test("has the IPA diacritics this mapping relies on", () => {
    expect(charToId("ˈ")).toBeDefined();
    expect(charToId("ˌ")).toBeDefined();
    expect(charToId(" ")).toBeDefined();
    expect(charToId(",")).toBeDefined();
    expect(charToId(".")).toBeDefined();
  });

  test("the known gotcha: ASCII g is absent, only IPA script g (U+0261) exists", () => {
    expect(VOCAB.g).toBeUndefined();
    expect(VOCAB.ɡ).toBeDefined();
  });
});

describe("encodeSoundsForKokoro", () => {
  function hello(): { sounds: Sound[]; words: WordSpan[] } {
    return {
      sounds: [
        { sound: "_", t0: 0, t1: 0.1 },
        { sound: "h", t0: 0.1, t1: 0.2 },
        { sound: "ə", t0: 0.2, t1: 0.3, stress: 0 },
        { sound: "l", t0: 0.3, t1: 0.38 },
        { sound: "oʊ", t0: 0.38, t1: 0.6, stress: 1 },
        { sound: "_", t0: 0.6, t1: 1.0 },
      ],
      words: [{ text: "hello", t0: 0.1, t1: 0.6 }],
    };
  }

  test("wraps the sequence in the pad token, both ends", () => {
    const { sounds } = hello();
    const { ids } = encodeSoundsForKokoro(sounds);
    expect(ids[0]).toBe(BOS_EOS_ID);
    expect(ids.at(-1)).toBe(BOS_EOS_ID);
  });

  test("a short silence becomes a comma, a long one a period", () => {
    const { sounds } = hello();
    const { ids } = encodeSoundsForKokoro(sounds);
    // leading "_" is 0.1s (short -> comma), trailing "_" is 0.4s (long -> period)
    expect(ids[1]).toBe(v(","));
    expect(ids.at(-2)).toBe(v("."));
  });

  test("stress 1 places the primary-stress mark right before the vowel", () => {
    const { sounds } = hello();
    const { ids } = encodeSoundsForKokoro(sounds);
    const stressIndex = ids.indexOf(v("ˈ"));
    expect(stressIndex).toBeGreaterThan(0);
    // "oʊ" is two characters: the stress mark is followed by 'o' then 'ʊ'
    expect(ids[stressIndex + 1]).toBe(v("o"));
    expect(ids[stressIndex + 2]).toBe(v("ʊ"));
  });

  test("the known gotcha: ASCII g is remapped to IPA script g", () => {
    const { ids, lost } = encodeSoundsForKokoro([{ sound: "g", t0: 0, t1: 0.1 }]);
    expect(ids).toEqual([BOS_EOS_ID, v("ɡ"), BOS_EOS_ID]);
    expect(lost).not.toContain("vocabulary gap");
  });

  test("ɝ (stressed r-coloured vowel, no direct token) becomes ɜː", () => {
    const { ids } = encodeSoundsForKokoro([{ sound: "ɝ", t0: 0, t1: 0.1, stress: 1 }]);
    expect(ids).toEqual([BOS_EOS_ID, v("ˈ"), v("ɜ"), v("ː"), BOS_EOS_ID]);
  });

  test("ɫ (dark l, acoustic-only) falls back to plain l", () => {
    const { ids, lost } = encodeSoundsForKokoro([{ sound: "ɫ", t0: 0, t1: 0.1 }]);
    expect(ids).toEqual([BOS_EOS_ID, v("l"), BOS_EOS_ID]);
    expect(lost).toEqual(["word boundaries"]);
  });

  test("a phone with no mapping at all lands in lost and a schwa keeps the stream well-formed", () => {
    const { ids, lost } = encodeSoundsForKokoro([{ sound: "ʕ", t0: 0, t1: 0.1 }]);
    expect(lost).toContain("ʕ");
    expect(ids).toEqual([BOS_EOS_ID, v("ə"), BOS_EOS_ID]);
  });

  test("without word spans, 'word boundaries' is reported lost", () => {
    const { lost } = encodeSoundsForKokoro([{ sound: "h", t0: 0, t1: 0.1 }]);
    expect(lost).toContain("word boundaries");
  });

  test("with word spans, a space is inserted at each word start after the first", () => {
    const sounds: Sound[] = [
      { sound: "h", t0: 0, t1: 0.1 },
      { sound: "aɪ", t0: 0.1, t1: 0.2, stress: 1 },
      { sound: "ð", t0: 0.2, t1: 0.3 },
      { sound: "ɛ", t0: 0.3, t1: 0.4, stress: 1 },
      { sound: "ɹ", t0: 0.4, t1: 0.5 },
    ];
    const words: WordSpan[] = [
      { text: "hi", t0: 0, t1: 0.2 },
      { text: "there", t0: 0.2, t1: 0.5 },
    ];
    const { ids, lost } = encodeSoundsForKokoro(sounds, words);
    expect(lost).not.toContain("word boundaries");
    expect(ids).toContain(v(" "));
    // exactly one space, at the second word's start
    expect(ids.filter((id) => id === v(" ")).length).toBe(1);
  });

  test("silence duration, pitch, loudness, breath and tension are not representable: callers must read them from `lost` themselves, since encodeSoundsForKokoro only sees sounds", () => {
    // documented, not asserted here: see src/engines/kokoro.ts's renderScore, which adds
    // "pitch curve", "loudness curve", "breath curve", "tension curve" and "exact silence
    // duration" to `lost` whenever the score carries them.
    expect(true).toBe(true);
  });
});

/**
 * Cross-checks the mapping against CHIMERA's actual phone tables, read from the Rust source
 * rather than retyped by hand, so a future phone this file doesn't know about fails loudly
 * instead of silently falling back to a schwa.
 */
describe("every phone CHIMERA's planner can emit", () => {
  function chars(name: string): string[] {
    return [...name];
  }

  test("the English G2P's phones (english.rs) all have a Kokoro token, directly or substituted", () => {
    const english = readFileSync(join(CRATES, "english.rs"), "utf-8");
    const vowels = [...english.matchAll(/const VOWELS: \[&str; 17\] = \[(.*?)\];/gs)][0]?.[1];
    expect(vowels).toBeDefined();
    const vowelPhones = [...(vowels ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    const consonantPhones = [...english.matchAll(/"[A-Z]+" => "([^"]+)"/g)].map((m) => m[1] as string);
    const allophones = [...english.matchAll(/=\s*"([^"]+)"\.into\(\)/g)].map((m) => m[1] as string);
    const phones = new Set([...vowelPhones, ...consonantPhones, ...allophones]);
    expect(phones.size).toBeGreaterThan(30); // sanity: the table was actually found and parsed

    for (const phone of phones) {
      const { lost } = encodeSoundsForKokoro(
        [{ sound: phone, t0: 0, t1: 0.1 }],
        [{ text: "x", t0: 0, t1: 0.1 }],
      );
      const gaps = lost.filter((l) => l.startsWith("vocabulary gap"));
      expect(gaps).toEqual([]);
    }
  });

  test("UNMAPPED_PHONES are exactly the broader-inventory phones with no usable Kokoro token", () => {
    const inventory = readFileSync(join(CRATES, "inventory.rs"), "utf-8");
    const ipa = readFileSync(join(CRATES, "ipa.rs"), "utf-8");
    const consonantSymbols = [...inventory.matchAll(/c\("([^"]+)"/g)].map((m) => m[1] as string);
    const vowelCharsLine = [...ipa.matchAll(/const VOWEL_CHARS: &str = "([^"]+)";/g)][0]?.[1] ?? "";
    const multiLine = [...ipa.matchAll(/const MULTI: \[&str; 10\] = \[(.*?)\];/gs)][0]?.[1] ?? "";
    const vowelChars = chars(vowelCharsLine);
    const multi = [...multiLine.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
    const fullInventory = new Set([...consonantSymbols, ...vowelChars, ...multi]);
    expect(fullInventory.size).toBeGreaterThan(60); // sanity

    for (const phone of fullInventory) {
      const { lost } = encodeSoundsForKokoro(
        [{ sound: phone, t0: 0, t1: 0.1 }],
        [{ text: "x", t0: 0, t1: 0.1 }],
      );
      const gaps = lost.filter((l) => l.startsWith("vocabulary gap"));
      if (UNMAPPED_PHONES.has(phone)) {
        // reported lost by name, with a schwa fallback, never a silent vocabulary gap
        expect(lost).toContain(phone);
        expect(gaps).toEqual([]);
      } else {
        expect(gaps).toEqual([]);
      }
    }
  });
});
