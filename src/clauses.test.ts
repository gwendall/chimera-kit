import { describe, expect, test } from "bun:test";
import { ClauseCutter, clauses, speakable } from "./clauses.ts";

/** Feeds `text` one character at a time, the worst case for a cutter. */
function trickle(text: string, options?: ConstructorParameters<typeof ClauseCutter>[0]) {
  const cutter = new ClauseCutter(options);
  const out: { clause: string; after: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    for (const clause of cutter.push(text[i] as string)) out.push({ clause, after: i + 1 });
  }
  for (const clause of cutter.end()) out.push({ clause, after: text.length });
  return out;
}

const all = async (text: string | string[], options?: ConstructorParameters<typeof ClauseCutter>[0]) =>
  Array.fromAsync(clauses(text, options));

describe("clauses", () => {
  test("end at sentences, at the first comma, then at commas once a clause has a few words", async () => {
    expect(await all("Sure, here is how it works. First, open the box; then read it!")).toEqual([
      "Sure,",
      "here is how it works.",
      "First, open the box;",
      "then read it!",
    ]);
  });

  test("come out as soon as the space after the punctuation arrives", () => {
    const text = "It rained all day. We stayed in.";
    const out = trickle(text);
    expect(out.map((o) => o.clause)).toEqual(["It rained all day.", "We stayed in."]);
    expect(out[0]?.after).toBe(text.indexOf(".") + 2);
  });

  test("give the same clauses whatever the pieces", async () => {
    const text = "Dr. Smith arrived at 3.30 p.m. on Monday. He said: no, not yet... Maybe later?";
    const whole = await all(text);
    expect(whole).toEqual([
      "Dr. Smith arrived at 3.30 p.m. on Monday.",
      "He said: no,",
      "not yet...",
      "Maybe later?",
    ]);
    expect(trickle(text).map((o) => o.clause)).toEqual(whole);
    expect(await all(text.match(/.{1,5}/gs) ?? [])).toEqual(whole);
  });

  test("cut a long run without punctuation before a conjunction", async () => {
    expect(await all("I went to the store yesterday and bought some apples and pears for the pie")).toEqual([
      "I went to the store yesterday",
      "and bought some apples and pears for the pie",
    ]);
    const plain = trickle("one two three four five six seven eight nine ten eleven", { maxWords: 4 });
    expect(plain.map((o) => o.clause)).toEqual([
      "one two three four",
      "five six seven eight",
      "nine ten eleven",
    ]);
  });

  test("never cut inside a word that is still arriving", () => {
    const cutter = new ClauseCutter({ maxWords: 2 });
    expect(cutter.push("alpha beta gam")).toEqual([]);
    expect(cutter.push("ma delta")).toEqual(["alpha beta"]);
    expect(cutter.end()).toEqual(["gamma delta"]);
  });

  test("turn dashes into pauses and ranges into words", async () => {
    expect(await all("It was late \u2014 too late - to call. Pages 4\u20139 matter.")).toEqual([
      "It was late,",
      "too late, to call.",
      "Pages 4 to 9 matter.",
    ]);
  });
});

describe("Markdown", () => {
  test("skips code blocks, even split across pieces", () => {
    const text = "Run this:\n\n```bash\nnpm install. Then go\n```\nThat is all.";
    expect(trickle(text).map((o) => o.clause)).toEqual(["Run this:", "That is all."]);
  });

  test("reads headings, lists and links as plain words", async () => {
    const text = "## Steps\n1. Open the **lid**.\n2. Read [the guide](https://x.dev/guide).\n- Done\n---\n";
    expect(await all(text)).toEqual(["Steps", "Open the lid.", "Read the guide.", "Done"]);
  });

  test("keeps underscores and stars that are not markup", () => {
    expect(speakable("call snake_case with 2 * 3")).toBe("call snake_case with 2 * 3");
    expect(speakable("_really_ **bold** `code` ~~gone~~")).toBe("really bold code gone");
  });

  test("reads table rows cell by cell and drops the header line", () => {
    expect(speakable("| name | age |")).toBe("name, age");
    expect(speakable("|---|:---:|")).toBe("");
  });

  test("can be turned off", async () => {
    expect(await all("## Title\nA *star*.", { markdown: false })).toEqual(["## Title", "A *star*."]);
  });
});
