#!/usr/bin/env bun
/**
 * Measures the Kokoro backend (`intone/kokoro`) on this machine: download size, cold start, time
 * to first audio, real-time factor and peak memory, downloading the real model. Also writes WAVs
 * for a human to listen to. This is not a test: there's nothing here to assert against, only
 * numbers to read and report.
 *
 *   bun scripts/kokoro-check.ts
 *
 * Needs `kokoro-js` and `@huggingface/transformers` installed (optional peer dependencies of
 * `intone/kokoro`; `bun install` in this repo already has them as devDependencies). Downloads the
 * q8 model (about 90 MB) to a cache directory outside the repo on first run, and reuses it after.
 *
 * The gotcha this works around: `@huggingface/transformers`'s `env.cacheDir` defaults to
 * `./.cache`, relative to the current working directory, not any shared Hugging Face cache. Left
 * alone, running this from the repo root would write the model into the repo. We set it to a
 * fixed directory under the user's cache home instead, before anything loads the model.
 *
 * A second gotcha, found by running this: even once every file is cached, `from_pretrained` still
 * issues a revalidation request per file (presumably an ETag check) before using the cache. On
 * the machine this was written on, that request hung indefinitely (no timeout, no error) on a
 * repeat run, well past the point where every file already existed on disk; the bare download
 * itself had finished in well under a minute. `KOKORO_CHECK_OFFLINE=1` sets
 * `env.allowRemoteModels = false` to skip it and resolve from the cache alone, verified down to
 * 1.8 s cold start once the model is cached. Left unset (the default, for an honest first-run
 * measurement), a slow or hanging network is exactly what this script is also here to catch.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";

// Outside the repo on purpose (see the module doc comment above); persists across runs so a
// repeat check doesn't re-download.
const CACHE_DIR = join(homedir(), ".cache", "intone-kokoro-check");
env.cacheDir = `${CACHE_DIR}/`;
if (process.env.KOKORO_CHECK_OFFLINE === "1") env.allowRemoteModels = false;

setTimeout(() => {
  console.error("kokoro-check: over its 10 minute budget");
  process.exit(1);
}, 600_000).unref();

const { encodeWav } = await import("../eval/wav.js");
const { birchCanoeScore } = await import("../src/engines/kokoro-fixture.js");
const { createKokoroVoice } = await import("../src/engines/kokoro.js");

const OUT_DIR = join(import.meta.dir, "../eval/out/kokoro");
await mkdir(OUT_DIR, { recursive: true });

const SENTENCES: { slug: string; text: string }[] = [
  { slug: "01-birch-canoe", text: "The birch canoe slid on the smooth planks." },
  { slug: "02-glue-sheet", text: "Glue the sheet to the dark blue background." },
  { slug: "03-tell-depth", text: "It's easy to tell the depth of a well." },
];

/** Total bytes of every regular file under `dir`, recursively. 0 if `dir` doesn't exist yet. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

let peakRssBytes = 0;
const sampleRss = () => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
};
const rssTimer = setInterval(sampleRss, 200);
sampleRss();

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

try {
  const dtype = "q8" as const;
  const cacheBefore = await dirSize(CACHE_DIR);

  const coldStartStart = performance.now();
  const voice = await createKokoroVoice({ dtype });
  const coldStartMs = performance.now() - coldStartStart;
  sampleRss();

  const cacheAfter = await dirSize(CACHE_DIR);
  const downloadedBytes = Math.max(0, cacheAfter - cacheBefore);

  // Time from calling `stream` to its first chunk, for the first sentence. A second, separate
  // call from `render` below gets the audio actually written to disk, so this measurement is
  // never mixed with audio we keep.
  const firstSentence = SENTENCES[0];
  if (firstSentence === undefined) throw new Error("kokoro-check: SENTENCES is empty");
  const streamStart = performance.now();
  const firstChunk = await voice.stream(firstSentence.text).next();
  const firstAudioMs = performance.now() - streamStart;
  sampleRss();
  if (firstChunk.done) throw new Error("kokoro-check: stream() produced no audio");

  const rtfs: number[] = [];
  for (const sentence of SENTENCES) {
    const renderStart = performance.now();
    const { audio, sampleRate } = await voice.render(sentence.text);
    const renderMs = performance.now() - renderStart;
    sampleRss();
    const audioSeconds = audio.length / sampleRate;
    rtfs.push(audioSeconds / (renderMs / 1000));
    await Bun.write(join(OUT_DIR, `${sentence.slug}.wav`), encodeWav(audio, sampleRate));
  }

  const score = birchCanoeScore();
  const scoreRendered = await voice.renderScore(score);
  sampleRss();
  await Bun.write(
    join(OUT_DIR, "04-score-birch-canoe.wav"),
    encodeWav(scoreRendered.audio, scoreRendered.sampleRate),
  );

  voice.free();

  console.log(`dtype: ${dtype}`);
  console.log(`cache directory: ${CACHE_DIR}`);
  console.log(`on-disk model size (this dtype, this run's delta): ${mb(downloadedBytes)} MB`);
  console.log(`cold start (from_pretrained): ${coldStartMs.toFixed(0)} ms`);
  console.log(`stream() to first audio chunk, sentence 1: ${firstAudioMs.toFixed(0)} ms`);
  console.log(
    `real-time factor per sentence: ${rtfs.map((r) => r.toFixed(2)).join(", ")} (audio seconds / wall seconds; >1 is faster than real time)`,
  );
  console.log(`peak RSS: ${mb(peakRssBytes)} MB`);
  console.log(`WAVs written under: ${OUT_DIR}`);
  for (const sentence of SENTENCES) console.log(`  ${sentence.slug}.wav: "${sentence.text}"`);
  console.log(`  04-score-birch-canoe.wav: from renderScore(), bypassing Kokoro's own phonemizer`);
  console.log(`score path lost: ${JSON.stringify(scoreRendered.lost)}`);
} finally {
  clearInterval(rssTimer);
}
