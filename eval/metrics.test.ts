import { describe, expect, test } from "bun:test";
import { compare, type ItemScore, wer, wordErrors, words } from "./metrics.ts";

describe("words", () => {
  test("ignores case and punctuation, keeps inner apostrophes", () => {
    expect(words("It's  EASY, to tell!")).toEqual(["it's", "easy", "to", "tell"]);
    expect(words("the dogs’ 'bone'")).toEqual(["the", "dogs", "bone"]);
    expect(words("  ...  ")).toEqual([]);
  });
});

describe("wordErrors", () => {
  test("counts substitutions, insertions and deletions", () => {
    expect(wordErrors(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
    expect(wordErrors(["a", "b", "c"], ["a", "x", "c"])).toBe(1);
    expect(wordErrors(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(wordErrors(["a", "b"], ["a", "x", "b"])).toBe(1);
    expect(wordErrors(["a", "b"], [])).toBe(2);
    expect(wordErrors([], ["a"])).toBe(1);
  });
});

describe("wer", () => {
  test("is a percentage over all words", () => {
    expect(
      wer([
        { errors: 1, words: 4 },
        { errors: 0, words: 6 },
      ]),
    ).toBe(10);
    expect(wer([])).toBe(0);
  });
});

function items(errors: number[]): ItemScore[] {
  return errors.map((e, i) => ({ key: `s${i}`, errors: e, words: 10 }));
}

describe("compare", () => {
  test("a broad improvement is better", () => {
    const result = compare(items(Array(40).fill(4)), items(Array(40).fill(2)));
    expect(result.verdict).toBe("better");
    expect(result.change).toBeCloseTo(-20);
  });

  test("a broad regression is worse", () => {
    expect(compare(items(Array(40).fill(2)), items(Array(40).fill(4))).verdict).toBe("worse");
  });

  test("identical runs show no change", () => {
    const same = items(Array(40).fill(3));
    const result = compare(same, same);
    expect(result.verdict).toBe("no clear change");
    expect(result.change).toBe(0);
  });

  test("one lucky sentence is not an improvement", () => {
    const before = items(Array(40).fill(3));
    const after = items([0, ...Array(39).fill(3)]);
    expect(compare(before, after).verdict).toBe("no clear change");
  });

  test("refuses runs over different sentences", () => {
    const other = [{ key: "elsewhere", errors: 0, words: 1 }];
    expect(() => compare(items([1]), other)).toThrow("same sentences");
  });
});
