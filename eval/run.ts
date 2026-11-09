#!/usr/bin/env bun
/**
 * Scores intelligibility: renders the corpus through the built package, has speech recognizers
 * transcribe it, and counts word errors. See eval/README.md for what a tuning loop may read.
 *
 *   bun eval/run.ts --name <run> [--splits dev,held] [--backends parakeet,whisper]
 *                   [--bodies male,female] [--against eval/baselines/x.json] [--control Samantha]
 *
 * --control renders with macOS `say` instead: a known-good voice that shows the harness's floor.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Body } from "../dist/index.js";
import { type Comparison, compare, type ItemScore, wer, wordErrors, words } from "./metrics.ts";
import type { RenderJob } from "./render-worker.ts";

/** Bump when scoring or the corpus's meaning changes: reports of different versions never compare. */
const JUDGE_VERSION = 1;
const WORKERS = 4;
const EVAL = import.meta.dir;

interface Sentence {
  id: string;
  kind: string;
  split: string;
  text: string;
}

interface Scored extends ItemScore {
  id: string;
  kind: string;
  body: string;
  split: string;
}

interface Report {
  judge: number;
  corpus: string;
  commit: string;
  dirty: boolean;
  engine: string;
  voice: string;
  /** backend, then split, then group ("all", "harvard/male"...), then percent. */
  wer: Record<string, Record<string, Record<string, number>>>;
  items: Record<string, Scored[]>;
  /** Dev sentences only: the held and locked transcripts are never written anywhere. */
  dev: Record<string, { id: string; body: string; text: string; heard: string; errors: number }[]>;
}

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    splits: { type: "string", default: "dev,held" },
    backends: { type: "string", default: "parakeet,whisper" },
    bodies: { type: "string", default: "male,female" },
    against: { type: "string" },
    control: { type: "string" },
  },
});
if (!values.name) throw new Error("--name is required");

function output(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function renderAll(jobs: RenderJob[]): Promise<void> {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: WORKERS }, () => {
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL("./render-worker.ts", import.meta.url));
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = () => {
          const job = queue.shift();
          if (job) {
            worker.postMessage(job);
          } else {
            worker.terminate();
            resolve();
          }
        };
      });
    }),
  );
}

function controlRender(voice: string, jobs: RenderJob[]): void {
  for (const job of jobs) {
    output(["say", "-v", voice, "-o", job.path, "--data-format=LEI16@48000", job.text]);
  }
}

async function transcribe(backend: string, manifest: string, out: string): Promise<Record<string, string>> {
  const process = Bun.spawn([join(EVAL, "asr.py"), backend, manifest, out], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await process.exited) !== 0) throw new Error(`${backend} failed`);
  return Bun.file(out).json();
}

function groupRates(items: Scored[]): Record<string, number> {
  const groups = new Map<string, Scored[]>([["all", items]]);
  for (const item of items) {
    for (const key of [`${item.kind}/${item.body}`, item.kind, item.body]) {
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  }
  return Object.fromEntries([...groups].sort().map(([key, group]) => [key, Number(wer(group).toFixed(2))]));
}

function verdictLine(label: string, c: Comparison): string {
  const fmt = (x: number) => x.toFixed(2);
  return `  ${label}: ${fmt(c.before)} -> ${fmt(c.after)} % (${c.change > 0 ? "+" : ""}${fmt(c.change)}, 95 % interval ${fmt(c.low)} to ${fmt(c.high)}) ${c.verdict.toUpperCase()}`;
}

/** Keep a change only if the loop's score improves and no split on any recognizer got worse. */
function decide(before: Report, after: Report, backends: string[]): void {
  if (before.judge !== after.judge || before.corpus !== after.corpus) {
    throw new Error("the runs used a different judge version or corpus: not comparable");
  }
  console.log(`\nagainst ${values.against}`);
  let loopBetter = false;
  let worse = false;
  for (const backend of backends) {
    for (const split of ["dev", "held"]) {
      const select = (report: Report) =>
        (report.items[backend] ?? [])
          .filter((item) => item.split === split)
          .map(({ key, errors, words: n }) => ({ key, errors, words: n }));
      const a = select(before);
      const b = select(after);
      if (a.length === 0 || b.length === 0) continue;
      const comparison = compare(a, b);
      console.log(verdictLine(`${backend} ${split}`, comparison));
      if (backend === backends[0] && split === "dev") loopBetter = comparison.verdict === "better";
      if (comparison.verdict === "worse") worse = true;
    }
  }
  console.log(`decision: ${worse ? "REJECT" : loopBetter ? "KEEP" : "NO CLEAR CHANGE"}`);
}

const splits = (values.splits as string).split(",");
const backends = (values.backends as string).split(",");
const bodies = values.control ? [`say-${values.control}`] : (values.bodies as string).split(",");
const out = join(EVAL, "out", values.name);
await mkdir(join(out, "audio"), { recursive: true });

const corpusText = await Bun.file(join(EVAL, "corpus/en.tsv")).text();
const corpus: Sentence[] = corpusText
  .trim()
  .split("\n")
  .map((line) => {
    const [id, kind, split, text] = line.split("\t") as [string, string, string, string];
    return { id, kind, split, text };
  });
const selected = corpus.filter((sentence) => splits.includes(sentence.split));
const keyOf = (sentence: Sentence, body: string) => `${sentence.id}/${body}`;
const pathOf = (sentence: Sentence, body: string) => join(out, "audio", `${sentence.id}-${body}.wav`);

const jobs: RenderJob[] = selected.flatMap((sentence) =>
  bodies.map((body) => ({ text: sentence.text, body: body as Body, path: pathOf(sentence, body) })),
);
const started = performance.now();
if (values.control) controlRender(values.control, jobs);
else await renderAll(jobs);
console.log(`rendered ${jobs.length} utterances in ${((performance.now() - started) / 1000).toFixed(1)} s`);

const manifest = join(out, "manifest.json");
await Bun.write(
  manifest,
  JSON.stringify(
    selected.flatMap((sentence) =>
      bodies.map((body) => ({ key: keyOf(sentence, body), path: pathOf(sentence, body) })),
    ),
  ),
);

const engine = (await Bun.file(join(EVAL, "../crates/chimera/Cargo.toml")).exists())
  ? output([
      "bash",
      "-c",
      "git log -1 --grep='^git-subtree-dir: crates/chimera' --format=%b | sed -n 's/^git-subtree-split: //p'",
    ])
  : "";
const report: Report = {
  judge: JUDGE_VERSION,
  corpus: createHash("sha256").update(corpusText).digest("hex").slice(0, 16),
  commit: output(["git", "rev-parse", "--short", "HEAD"]),
  dirty: output(["git", "status", "--porcelain", "--", "crates", "src"]) !== "",
  engine,
  voice: values.control ? `say:${values.control}` : "chimera",
  wer: {},
  items: {},
  dev: {},
};

for (const backend of backends) {
  const transcripts = await transcribe(backend, manifest, join(out, `${backend}.transcripts.json`));
  const scored = selected.flatMap((sentence) =>
    bodies.map((body) => {
      const key = keyOf(sentence, body);
      const heard = transcripts[key] ?? "";
      const reference = words(sentence.text);
      return {
        key,
        id: sentence.id,
        kind: sentence.kind,
        split: sentence.split,
        body,
        heard,
        text: sentence.text,
        errors: wordErrors(reference, words(heard)),
        words: reference.length,
      };
    }),
  );
  report.items[backend] = scored.map(({ key, id, kind, split, body, errors, words: n }) => ({
    key,
    id,
    kind,
    split,
    body,
    errors,
    words: n,
  }));
  report.wer[backend] = Object.fromEntries(
    splits.map((split) => [split, groupRates(scored.filter((item) => item.split === split))]),
  );
  report.dev[backend] = scored
    .filter((item) => item.split === "dev")
    .map(({ id, body, text, heard, errors }) => ({ id, body, text, heard, errors }));
  // The raw transcripts include the held-out sentences: only the scores may survive the run.
  await Bun.file(join(out, `${backend}.transcripts.json`)).delete();
}

await Bun.write(join(out, "report.json"), `${JSON.stringify(report, null, 1)}\n`);

for (const backend of backends) {
  console.log(`\n${backend} word error rate (%)`);
  for (const [split, groups] of Object.entries(report.wer[backend] ?? {})) {
    console.log(
      `  ${split}: ${Object.entries(groups)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  }
}
console.log(`\nreport: ${join(out, "report.json")}`);

if (values.against) {
  decide(await Bun.file(values.against).json(), report, backends);
}
