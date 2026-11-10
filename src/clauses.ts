/**
 * Text that arrives in pieces, such as a language model's tokens, cut into clauses that can be
 * spoken one after the other while the rest is still being written. A clause ends at its
 * punctuation or at a line end; a long run without punctuation is cut before a conjunction.
 */

export interface ClauseOptions {
  /**
   * A comma, semicolon, colon or dash ends a clause once it holds this many words (default 3, at
   * most `maxWords`). The first clause ends at its first punctuation, so speech starts early.
   */
  minWords?: number;
  /** A run without punctuation is cut after at most this many words (default 8). */
  maxWords?: number;
  /** Reads the text as Markdown: drops code blocks, markup and link targets (default true). */
  markdown?: boolean;
}

type Text = string | Iterable<string> | AsyncIterable<string>;

/** Yields the clauses of `text` as soon as each one is complete. */
export async function* clauses(text: Text, options?: ClauseOptions): AsyncGenerator<string, void, undefined> {
  const cutter = new ClauseCutter(options);
  for await (const piece of typeof text === "string" ? [text] : text) yield* cutter.push(piece);
  yield* cutter.end();
}

/** Closing marks that stay with the punctuation before them. */
const CLOSERS = `["'\u201d\u2019)\\]*_\`]*`;
/** Where a clause may end. The lookahead waits for the next character before deciding. */
const BOUNDARY = new RegExp(
  `\\n|[.!?\u2026]+${CLOSERS}(?=\\s)|[,;:]${CLOSERS}(?=\\s)|\\s-(?=\\s)|\\s*[\u2013\u2014]`,
  "gu",
);
/** A period after these is not the end of a sentence. */
const ABBREVIATION = /(?:^|[\s("'])(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|Mt|[A-Za-z]|(?:[A-Za-z]\.)+[A-Za-z])$/;
const CONJUNCTION =
  /^(?:and|but|or|nor|so|yet|because|which|that|who|whom|whose|when|while|where|if|then|than|although|though|unless|until|since|whereas)$/i;
const WORD = /\S*[\p{L}\p{N}]\S*/gu;
const FENCE = /^[ \t]*(?:```|~~~)/;

/**
 * The cutter itself: push pieces of text as they come, get back the clauses they complete, and
 * call `end` once the text is over.
 */
export class ClauseCutter {
  private buffer = "";
  private lineStart = true;
  private fenced = false;
  private spoken = false;
  private readonly minWords: number;
  private readonly maxWords: number;
  private readonly markdown: boolean;

  constructor({ maxWords = 8, minWords = Math.min(3, maxWords), markdown = true }: ClauseOptions = {}) {
    if (
      !(Number.isInteger(minWords) && minWords >= 1 && Number.isInteger(maxWords) && maxWords >= minWords)
    ) {
      throw new RangeError(
        `chimera-kit: need whole numbers 1 <= minWords <= maxWords, got ${minWords} and ${maxWords}`,
      );
    }
    this.minWords = minWords;
    this.maxWords = maxWords;
    this.markdown = markdown;
  }

  push(piece: string): string[] {
    this.buffer += piece;
    return this.drain(false);
  }

  end(): string[] {
    const out = this.drain(true);
    this.buffer = "";
    this.lineStart = true;
    this.fenced = false;
    this.spoken = false;
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    while (this.buffer !== "") {
      if (this.markdown && this.lineStart && this.atFence(final)) {
        // Code is not read aloud: skip whole lines until the fence closes.
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) {
          if (final) this.buffer = "";
          break;
        }
        if (FENCE.test(this.buffer.slice(0, newline))) this.fenced = !this.fenced;
        this.buffer = this.buffer.slice(newline + 1);
        continue;
      }
      const end = this.boundary(final);
      if (end === undefined) break;
      const raw = this.buffer.slice(0, end);
      const rest = this.buffer.slice(end);
      const gap = /^\s*/.exec(rest)?.[0] ?? "";
      const clause = this.markdown ? speakable(raw, this.lineStart) : tidy(raw);
      if (clause !== "") {
        out.push(clause);
        this.spoken = true;
      }
      this.lineStart = raw.endsWith("\n") || gap.includes("\n");
      this.buffer = rest.slice(gap.length);
    }
    return out;
  }

  /** The buffer starts a code fence, is inside one, or might be the start of one. */
  private atFence(final: boolean): boolean {
    if (this.fenced || FENCE.test(this.buffer)) return true;
    return !final && /^[ \t]*(?:`{1,2}|~{1,2})$/.test(this.buffer);
  }

  /** The end of the first clause in the buffer, or undefined while it is not complete. */
  private boundary(final: boolean): number | undefined {
    const text = this.buffer;
    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(text); m; m = BOUNDARY.exec(text)) {
      const at = m.index;
      const mark = m[0];
      if (mark === "\n") return at + 1;
      const before = text.slice(0, at);
      if (/^[.!?\u2026]/.test(mark)) {
        if (mark.startsWith(".") && !mark.startsWith("..") && ABBREVIATION.test(before)) continue;
        if (this.lineStart && /^\s*\d+$/.test(before)) continue; // "1. " starts a list item
        return at + mark.length;
      }
      if (count(before) >= (this.spoken ? this.minWords : 1)) return at + mark.length;
    }
    const cut = this.overflow(text);
    if (cut !== undefined) return cut;
    return final ? text.length : undefined;
  }

  /** Where to cut a run longer than `maxWords` words: before its last conjunction, or after the limit. */
  private overflow(text: string): number | undefined {
    const words: { start: number; end: number; text: string }[] = [];
    WORD.lastIndex = 0;
    for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
      const end = m.index + m[0].length;
      if (end >= text.length) break; // the word may not be finished
      words.push({ start: m.index, end, text: m[0] });
    }
    if (words.length <= this.maxWords) return undefined;
    for (let k = this.maxWords; k >= this.minWords; k--) {
      const next = words[k];
      if (next && CONJUNCTION.test(next.text)) return next.start;
    }
    return words[this.maxWords - 1]?.end;
  }
}

function count(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** Collapses whitespace and turns dashes into the pause they stand for. */
function tidy(text: string): string {
  return text
    .replace(/(\d)\s*[\u2013\u2014]\s*(?=\d)/gu, "$1 to ")
    .replace(/\s*[\u2013\u2014]\s*|\s+-(?=\s|$)/gu, ", ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+/, "")
    .trim();
}

/** The words of a piece of Markdown, without the markup. */
export function speakable(markdown: string, lineStart = true): string {
  let s = markdown;
  if (lineStart) {
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(s)) return ""; // a rule
    if (/^\s*\|?[\s:|-]*-[\s:|-]*$/.test(s) && s.includes("|")) return ""; // a table's header line
    s = s.replace(/^\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)+/, "");
  }
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(?:https?:|mailto:)[^>]*>/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/`+/g, "")
    .replace(/~~/g, "")
    .replace(/(?<![\p{L}\p{N}\\])[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?![\p{L}\p{N}])/gu, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .replace(/\s*\|\s*/g, ", ");
  const clause = tidy(s);
  return /[\p{L}\p{N}]/u.test(clause) ? clause : "";
}
