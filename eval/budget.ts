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
  "chimera_speak.wasm": 200_000,
  "index.js": 2_000,
  "cmudict.txt.gz": 880_000,
};
/** Share of one core a voice may use in real time, measured in Bun. */
const CORE_LIMIT = 0.45;

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
  const voice = await createVoice();
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
