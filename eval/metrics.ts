/** Word error rate and the comparison of two runs. Pure functions, so they can be tested. */

export interface ItemScore {
  key: string;
  errors: number;
  words: number;
}

export interface Comparison {
  before: number;
  after: number;
  /** Percentage points; negative is better. */
  change: number;
  /** 95 % interval of the change, in points, from resampling the sentences. */
  low: number;
  high: number;
  verdict: "better" | "worse" | "no clear change";
}

/** Lowercase words, without punctuation. An apostrophe inside a word stays ("it's"). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll("’", "'")
    .replace(/[^\p{L}' ]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** Levenshtein distance between two word lists. */
export function wordErrors(reference: readonly string[], heard: readonly string[]): number {
  const row = Array.from({ length: heard.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i++) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= heard.length; j++) {
      const above = row[j] as number;
      const cost = reference[i - 1] === heard[j - 1] ? 0 : 1;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return row[heard.length] as number;
}

/** Percentage of reference words wrong. */
export function wer(items: readonly Pick<ItemScore, "errors" | "words">[]): number {
  const errors = items.reduce((sum, item) => sum + item.errors, 0);
  const total = items.reduce((sum, item) => sum + item.words, 0);
  return total === 0 ? 0 : (100 * errors) / total;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Whether a change is real or the luck of which sentences were tried. The same sentences are in
 * both runs, so it resamples them in pairs. The engine and the recognizers are deterministic, so
 * the sentence sample is the only noise there is.
 */
export function compare(before: readonly ItemScore[], after: readonly ItemScore[]): Comparison {
  const previous = new Map(before.map((item) => [item.key, item]));
  if (previous.size !== after.length || after.some((item) => !previous.has(item.key))) {
    throw new Error("the two runs did not score the same sentences");
  }
  const pairs = after.map((item) => {
    const old = previous.get(item.key) as ItemScore;
    return { delta: item.errors - old.errors, words: item.words };
  });
  const random = mulberry32(1);
  const samples = Array.from({ length: 2000 }, () => {
    let delta = 0;
    let total = 0;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[Math.floor(random() * pairs.length)] as (typeof pairs)[number];
      delta += pair.delta;
      total += pair.words;
    }
    return (100 * delta) / total;
  }).sort((a, b) => a - b);
  const low = samples[50] as number;
  const high = samples[1949] as number;
  const beforeWer = wer(before);
  const afterWer = wer(after);
  return {
    before: beforeWer,
    after: afterWer,
    change: afterWer - beforeWer,
    low,
    high,
    verdict: high < 0 ? "better" : low > 0 ? "worse" : "no clear change",
  };
}
