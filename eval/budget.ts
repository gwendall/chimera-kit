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
  // 188,032 before planning to a score and rendering one back (layer 2), 206,897 after, 221,182
  // with singing (plan_song and lyrics_to_syllables, +14.3 KB): 1.3 % of a first load with the
  // dictionary, and a separate singing build would carry the whole speech engine again. 273,867
  // with `chimera-kit/live` (`ic_live_*`/`ic_beat_*`, +52.7 KB): the held voice's own render path plus
  // the beatbox's `BeatSound` table, both newly linker-reachable, measured on the one wasm the
  // utterance and live APIs share (`bun eval/budget.ts --no-speed`, 2026-11-09).
  "chimera.wasm": 280_000,
  "cmudict.txt.gz": 880_000,
  // The 4 creatures (songbird, seal, alligator, elephant) and their airways: 108,935 measured.
  "creatures.wasm": 115_000,
};
/**
 * What an app's bundler keeps of the JavaScript for a given import, gzipped. The package has no
 * side effects, so an app ships only what it imports.
 */
const BUNDLE_LIMITS: Record<string, { imports: string[]; from?: string; limit: number }> = {
  // Removing provider entries changes Bun's shared chunks. The Chimera-only, renamed build
  // measures 2,083 bytes; keep 17 bytes of headroom without changing any engine/audio budget.
  "speaking (createVoice)": { imports: ["createVoice"], limit: 2_100 },
  // Songs (a voice plans and renders a Song) took the chat from 4,954 to 5,090, everything from
  // 8,979 to 9,123.
  // Sound on phones (`unlockAudio`: the iOS audio session, its fallback, resuming inside the tap) took
  // the chat from 5,180 to 5,466 and everything from 9,237 to 9,537. Without it an iPhone on silent
  // plays nothing. Two hangs of `play` fixed (`queued` when the worklet can't load, `done` when the
  // caller closes its own context mid-stream) took the chat from 5,466 to 5,541 and everything from
  // 9,549 to 9,623.
  "a chat (createVoice, speech, play)": { imports: ["createVoice", "speech", "play"], limit: 5_600 },
  // The `airway` stream option, which reads the simulated tube, took everything from 9,178 to 9,237.
  // `bodyFromSeed` (a voice of its own per seed: a small RNG, a string hash, twelve draws) took
  // everything from 9,623 to 10,021; an app that doesn't import it ships none of it.
  "everything (index.js)": { imports: [], limit: 10_100 },
  // `say` is a method, so its clause cutter stays in: this is a chat's page side.
  "a voice in a Worker, page side (createWorkerVoice, play)": {
    imports: ["createWorkerVoice", "play"],
    limit: 5_000,
  },
  // 2,362 before each clause's end was paced (withPause), 2,674 after, 2,747 with styles. 4,624 with
  // deliveries as data (`deliver` and the transforms it applies), which a worker must carry since a
  // style cannot be posted to it. The worker loads 207 KB of wasm and 869 KB of dictionary besides.
  // The provider-free graph measures 5,002 bytes on CI (4,999 locally after renaming).
  // Allow the small bundle-layout/platform difference, without relaxing the audio budgets.
  "a voice in a Worker, worker side (worker.js)": { imports: [], from: "worker.js", limit: 5_050 },
  // 1,752 bytes measured: loadCreatures alone, nothing speech-related pulled in.
  "the creatures (loadCreatures)": { imports: ["loadCreatures"], from: "creatures.js", limit: 2_000 },
  // `profile` is pure TypeScript with no engine import (type-only imports of Body and Delivery
  // are erased), so it carries nothing of the rest of the package: measured 2,587 bytes gzipped
  // (`bun eval/budget.ts --no-speed`, 2026-11-09). `body.brightness` and `body.breathiness` (a
  // blend-interpolated tilt fit - one intercept and slope per male/female/child anchor, instead
  // of a male-only fit that read a female voice's brightness back wrong by up to 0.4 - plus a
  // reliability gate that leaves breathiness `undefined` instead of misreading a clean voice as
  // somewhat breathy) took it to 2,889 (`--no-speed`, 2026-11-10).
  "imitating a voice (imitate.js)": { imports: ["profile"], from: "imitate.js", limit: 2_950 },
  // A new entry, so it costs nothing to an app that doesn't import it: measured 2,730 bytes gzipped
  // (`bun eval/budget.ts --no-speed`, 2026-11-09). The moods come with it, for the schema's list.
  "tool calls from a language model (tools.js)": {
    imports: ["createToolRunner", "forAnthropic", "forOpenAI"],
    from: "tools.js",
    limit: 3_000,
  },
  // A new entry too: 1,958 bytes gzipped measured with all of it imported (`--no-speed`, 2026-11-09).
  "songs (singing.js)": {
    imports: ["melody", "harmony", "keyOf", "scoop", "fall"],
    from: "singing.js",
    limit: 2_200,
  },
  // 1,529 bytes measured: createInstrument alone (the worklet's own code ships separately, loaded
  // by `context.audioWorklet.addModule`, so the page only carries the small main-thread half:
  // compiling the wasm, the worklet node, and the Safari DataCloneError fallback).
  "a played voice, page side (createInstrument)": {
    imports: ["createInstrument"],
    from: "live.js",
    limit: 2_000,
  },
  // 1,931 bytes measured, the UTF-8 fallback included: the AudioWorkletProcessor itself (the held
  // voice's engine wrapper and the message-handling switch), never loaded by the page's own bundle.
  "a played voice, worklet side (worklet-live.js)": {
    imports: [],
    from: "worklet-live.js",
    limit: 2_000,
  },
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

const BUNDLES = join(import.meta.dir, "out/bundles");
for (const [label, { imports, from: file = "index.js", limit }] of Object.entries(BUNDLE_LIMITS)) {
  const entry = join(BUNDLES, `${label.replace(/\W+/g, "-")}.js`);
  const from = JSON.stringify(join(DIST, file));
  await Bun.write(
    entry,
    imports.length > 0
      ? `import { ${imports.join(", ")} } from ${from};\nglobalThis.keep = [${imports.join(", ")}];\n`
      : `import * as all from ${from};\nglobalThis.keep = all;\n`,
  );
  const built = await Bun.build({ entrypoints: [entry], minify: true, target: "browser" });
  const output = built.outputs[0];
  if (!built.success || !output) throw new Error(`budget: could not bundle ${label}`);
  const size = Bun.gzipSync(new Uint8Array(await output.arrayBuffer()), { level: 9 }).length;
  check(`JavaScript for ${label}`, `${size} bytes gzipped (limit ${limit})`, size <= limit);
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
