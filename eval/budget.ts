#!/usr/bin/env bun
/**
 * Fails when the package grows or slows past its budget. Small and cheap are the point of it.
 *
 *   bun eval/budget.ts [--no-speed]    (--no-speed for CI runners, whose speed varies)
 */
import { join } from "node:path";
import { createVoice } from "../dist/index.js";

const DIST = join(import.meta.dir, "../dist");
/** Limits in bytes, gzipped. */
const SIZE_LIMITS: Record<string, number> = {
  "intone_chimera.wasm": 200_000,
  "index.js": 6_000,
  "cmudict.txt.gz": 880_000,
};
/** Share of one core a voice may use in real time, measured in Bun. */
const CORE_LIMIT = 0.45;
/** Loading the engine and the dictionary, once per page. */
const COLD_START_LIMIT_MS = 150;
/** From asking to speak to the first sample worth hearing: what a chat feels. */
const FIRST_AUDIO_LIMIT_MS = 15;

let failed = false;
function check(label: string, value: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "OVER"} ${label}: ${value}`);
  if (!ok) failed = true;
}

for (const [file, limit] of Object.entries(SIZE_LIMITS)) {
  const bytes = await Bun.file(join(DIST, file)).bytes();
  const size = file.endsWith(".gz") ? bytes.length : Bun.gzipSync(bytes, { level: 9 }).length;
  check(file, `${size} bytes gzipped (limit ${limit})`, size <= limit);
}

if (!process.argv.includes("--no-speed")) {
  const coldStarted = performance.now();
  const voice = await createVoice();
  const cold = performance.now() - coldStarted;
  check("cold start", `${cold.toFixed(1)} ms (limit ${COLD_START_LIMIT_MS} ms)`, cold <= COLD_START_LIMIT_MS);

  let firstAudio = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    for (const chunk of voice.stream("Hello there, how are you?")) {
      if (chunk.some((sample) => Math.abs(sample) > 1e-3)) {
        firstAudio = Math.min(firstAudio, performance.now() - started);
        break;
      }
    }
  }
  check(
    "first audible sample",
    `${firstAudio.toFixed(1)} ms (limit ${FIRST_AUDIO_LIMIT_MS} ms)`,
    firstAudio <= FIRST_AUDIO_LIMIT_MS,
  );

  let best = Number.POSITIVE_INFINITY;
  let seconds = 0;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    const { audio, sampleRate } = voice.render("The birch canoe slid on the smooth planks.");
    best = Math.min(best, (performance.now() - started) / 1000);
    seconds = audio.length / sampleRate;
  }
  voice.free();
  const load = best / seconds;
  check(
    "one voice",
    `${(load * 100).toFixed(1)} % of a core (limit ${CORE_LIMIT * 100} %)`,
    load <= CORE_LIMIT,
  );
}

process.exit(failed ? 1 : 0);
