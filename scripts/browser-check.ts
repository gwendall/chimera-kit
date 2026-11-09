/**
 * Checks the package in real browser engines (Chromium and WebKit): the engine loads, and the
 * player hands the audio thread exactly the samples that `render` gives. It plays into an
 * OfflineAudioContext, so it needs no sound card and is deterministic.
 *
 *   bun run build && bun scripts/browser-check.ts [chromium|webkit ...]
 *
 * Playwright's browsers come from `bunx playwright-core install chromium webkit`, or set
 * BROWSER_CHANNEL=chrome to use an installed Google Chrome.
 */
import { join } from "node:path";
import { type Browser, chromium, webkit } from "playwright-core";

setTimeout(() => {
  console.error("browser-check: over its 120 s budget");
  process.exit(1);
}, 120_000).unref();

const DIST = join(import.meta.dir, "../dist");
// https, not http: `BaseAudioContext.audioWorklet` only exists in a secure context, and a plain
// http origin isn't one (confirmed: `OfflineAudioContext.audioWorklet` is undefined there, with
// the rest of the suite's checks unaffected since they use no worklet).
const ORIGIN = "https://intone.test";
/** A browser installed on the system ("chrome" on CI runners) instead of Playwright's own. */
const CHANNEL = process.env.BROWSER_CHANNEL;
const TYPES: Record<string, string> = {
  js: "text/javascript",
  wasm: "application/wasm",
  gz: "application/gzip",
};
const engines = { chromium, webkit };
const wanted = (
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(engines)
) as (keyof typeof engines)[];

interface Result {
  loadMs: number;
  renderedSeconds: number;
  exact: { maxError: number; trailingMax: number; underruns: number };
  resampled: { rate: number; lengthRatio: number; rmsRatio: number; underruns: number };
  /** The device-voice entry loads next to the main one, and how many voices the browser lists. */
  systemVoices: number;
  /** A voice in the default Worker: its samples against render's, and its first chunk's delay. */
  worker: { maxError: number; length: number; firstChunkMs: number };
  /** `say` from the worker straight to the audio thread, a string then tokens, against renders. */
  say: { maxError: number; tokensMaxError: number; clauses: number; underruns: number; stoppedPeak: number };
  /** `intone/speaker`'s `createSpeaker("chimera", ...)`, against the same renders: it only wraps
   * `createWorkerVoice`, so it must keep the same guarantees. */
  speaker: { id: string; lost: string[]; renderError: number; sayError: number; stoppedPeak: number };
  /** The creatures' own wasm, loaded and heard in a browser. */
  creature: { kinds: number; samples: number; peak: number };
  /** A song through the worker to the audio thread: the samples of its render, nothing lost. */
  song: { lost: string[]; sayError: number };
  /** `intone/live`: a held voice through the real `AudioWorkletNode` + `addModule` pipeline (not
   * just the bare engine the bun tests exercise), and its beatbox. */
  live: {
    /** Offline, so sample-accurate: first audible sample after `noteOn`, and whether the beatbox
     * sounded too. */
    offline: { firstSampleMs: number; finite: boolean; peak: number; beatPeak: number };
  };
}

// intone/live's check runs on its own page, navigated here directly, rather than inside the main
// page.route-faked ORIGIN above. Two reasons, both found by hand: (1) `audioWorklet.addModule` on
// Chromium fetches its target through a loader page.route cannot intercept (a plain
// `${ORIGIN}/worklet-live.js` 404s there, chromium only); (2) even once the worklet file comes
// from a real server, loading it cross-origin from the page.route-faked ORIGIN is blocked by
// Private Network Access (ORIGIN's address space reads as unknown/public to Chromium, since
// nothing is really dialed, and a public page may not fetch a loopback target without a preflight
// that worklet module loading never sends - confirmed: the request never even reaches this
// server). A loopback address is a secure context on its own regardless of scheme, so serving the
// whole page from here and navigating straight to it sidesteps both: same origin throughout, no
// addModule interception gap, no cross-address-space fetch.
const liveServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname.slice(1);
    if (path === "")
      return new Response("<!doctype html><title>check</title>", {
        headers: { "content-type": "text/html" },
      });
    const file = Bun.file(join(DIST, path));
    if (!(await file.exists())) return new Response("", { status: 404 });
    const type = TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";
    return new Response(file, { headers: { "content-type": type } });
  },
});
const LIVE_ORIGIN = `http://127.0.0.1:${liveServer.port}`;

let failed = false;
try {
  for (const name of wanted) {
    let browser: Browser | undefined;
    try {
      browser = await engines[name].launch(CHANNEL ? { channel: CHANNEL } : {});
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(`${ORIGIN}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname.slice(1);
        if (path === "")
          return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>check</title>" });
        const file = Bun.file(join(DIST, path));
        if (!(await file.exists())) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({
          contentType: TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream",
          body: Buffer.from(await file.arrayBuffer()),
        });
      });
      await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
      const result: Omit<Result, "live"> & { live?: Result["live"] } = await page.evaluate(
        async ({ origin }) => {
          const { createVoice, createWorkerVoice, play, speech } = await import(`${origin}/index.js`);
          const collect = async (chunks: AsyncIterable<Float32Array>) => {
            const list: Float32Array[] = [];
            for await (const chunk of chunks) list.push(chunk);
            const out = new Float32Array(list.reduce((n, c) => n + c.length, 0));
            let at = 0;
            for (const c of list) {
              out.set(c, at);
              at += c.length;
            }
            return out;
          };
          const started = performance.now();
          const voice = await createVoice({ body: "female" });
          const loadMs = performance.now() - started;
          const text = "The birch canoe slid on the smooth planks.";
          const { audio, sampleRate } = voice.render(text);

          const exactContext = new OfflineAudioContext(1, audio.length + 4096, sampleRate);
          const exact = play(voice.stream(text), sampleRate, { context: exactContext, ahead: Infinity });
          await exact.queued;
          const exactOut = (await exactContext.startRendering()).getChannelData(0);
          const exactEnd = await exact.done;
          let maxError = 0;
          for (let i = 0; i < audio.length; i++)
            maxError = Math.max(maxError, Math.abs(exactOut[i] - audio[i]));
          let trailingMax = 0;
          for (let i = audio.length; i < exactOut.length; i++)
            trailingMax = Math.max(trailingMax, Math.abs(exactOut[i]));

          const rate = 44_100;
          const expected = Math.round((audio.length * rate) / sampleRate);
          const resampledContext = new OfflineAudioContext(1, expected + 4096, rate);
          const resampled = play(voice.stream(text), sampleRate, {
            context: resampledContext,
            ahead: Infinity,
          });
          await resampled.queued;
          const resampledOut = (await resampledContext.startRendering()).getChannelData(0);
          const resampledEnd = await resampled.done;
          let last = 0;
          for (let i = 0; i < resampledOut.length; i++) if (resampledOut[i] !== 0) last = i + 1;
          const rms = (x: Float32Array, n: number) => {
            let sum = 0;
            for (let i = 0; i < n; i++) sum += x[i] * x[i];
            return Math.sqrt(sum / n);
          };
          // What `say` should give, computed before this voice goes: `speech` paces each clause's end.
          const sayExpected: Float32Array = await collect(speech(voice, text));
          voice.free();

          const remote = await createWorkerVoice({ body: "female" });
          const asked = performance.now();
          let firstChunkMs = -1;
          const parts: Float32Array[] = [];
          for await (const chunk of remote.stream(text)) {
            if (firstChunkMs < 0) firstChunkMs = performance.now() - asked;
            parts.push(chunk);
          }
          // A string, then tokens: the worker writes into the player's port, the page never sees a sample.
          const sayContext = new OfflineAudioContext(1, sayExpected.length + 4096, sampleRate);
          const said = remote.say(text, { context: sayContext });
          await said.queued;
          const sayOut = (await sayContext.startRendering()).getChannelData(0);
          const sayEnd = await said.done;
          let sayError = 0;
          for (let i = 0; i < sayExpected.length; i++)
            sayError = Math.max(sayError, Math.abs(sayOut[i] - sayExpected[i]));
          for (let i = sayExpected.length; i < sayOut.length; i++)
            sayError = Math.max(sayError, Math.abs(sayOut[i]));

          const answer = "Sure, the canoe slid. It was *smooth*.";
          const { clauses } = await import(`${origin}/index.js`);
          const parts2: string[] = await Array.fromAsync(clauses(answer));
          const here = await createVoice({ body: "female" });
          const tokensExpected: Float32Array = await collect(speech(here, answer.match(/.{1,3}/gs) ?? []));
          here.free();
          const total = tokensExpected.length;
          async function* tokens() {
            for (const piece of answer.match(/.{1,3}/gs) ?? []) {
              await new Promise((resolve) => setTimeout(resolve, 2));
              yield piece;
            }
          }
          const tokensContext = new OfflineAudioContext(1, total + 4096, sampleRate);
          const saidTokens = remote.say(tokens(), { context: tokensContext });
          await saidTokens.queued;
          const tokensOut = (await tokensContext.startRendering()).getChannelData(0);
          await saidTokens.done;
          let tokensError = 0;
          for (let i = 0; i < total; i++)
            tokensError = Math.max(tokensError, Math.abs(tokensOut[i] - tokensExpected[i]));
          // Stopped before it plays: nothing is heard, and `done` still settles.
          const stopContext = new OfflineAudioContext(1, sampleRate, sampleRate);
          const interrupted = remote.say(`${text} ${text} ${text}`, { context: stopContext });
          interrupted.stop();
          await interrupted.queued;
          const stopOut = (await stopContext.startRendering()).getChannelData(0);
          await interrupted.done;
          let stoppedPeak = 0;
          for (const x of stopOut) stoppedPeak = Math.max(stoppedPeak, Math.abs(x));
          remote.free();
          let workerError = 0;
          let at = 0;
          for (const part of parts) {
            for (let i = 0; i < part.length; i++)
              workerError = Math.max(workerError, Math.abs(part[i] - audio[at + i]));
            at += part.length;
          }

          // The unified Speaker interface (`intone/speaker`): CHIMERA through it must keep the same
          // guarantees as `createWorkerVoice` directly, since it only wraps it.
          const { createSpeaker } = await import(`${origin}/speaker.js`);
          const chimeraSpeaker = await createSpeaker("chimera", { body: "female" });
          const speakerRendered = await chimeraSpeaker.render?.(text);
          let speakerRenderError = 0;
          for (let i = 0; i < audio.length; i++)
            speakerRenderError = Math.max(
              speakerRenderError,
              Math.abs((speakerRendered?.audio[i] ?? 0) - audio[i]),
            );
          const speakerSayContext = new OfflineAudioContext(1, sayExpected.length + 4096, sampleRate);
          const speakerSaid = chimeraSpeaker.say(text, { context: speakerSayContext });
          await speakerSaid.queued;
          const speakerSayOut = (await speakerSayContext.startRendering()).getChannelData(0);
          await speakerSaid.done;
          let speakerSayError = 0;
          for (let i = 0; i < sayExpected.length; i++)
            speakerSayError = Math.max(speakerSayError, Math.abs(speakerSayOut[i] - sayExpected[i]));
          // Stopped before it plays, through the unified interface too: nothing is heard.
          const speakerStopContext = new OfflineAudioContext(1, sampleRate, sampleRate);
          const speakerInterrupted = chimeraSpeaker.say(`${text} ${text}`, { context: speakerStopContext });
          speakerInterrupted.stop();
          await speakerInterrupted.queued;
          const speakerStopOut = (await speakerStopContext.startRendering()).getChannelData(0);
          await speakerInterrupted.done;
          let speakerStoppedPeak = 0;
          for (const x of speakerStopOut) speakerStoppedPeak = Math.max(speakerStoppedPeak, Math.abs(x));
          const song = { lyrics: "la la", notes: [60, 67].map((midi) => ({ midi, beats: 1 })), bpm: 120 };
          const songExpected: Float32Array =
            (await chimeraSpeaker.render?.(song))?.audio ?? new Float32Array();
          const songContext = new OfflineAudioContext(1, songExpected.length + 4096, sampleRate);
          const sung = chimeraSpeaker.say(song, { context: songContext });
          await sung.queued;
          const songOut = (await songContext.startRendering()).getChannelData(0);
          await sung.done;
          let songError = songExpected.length === 0 ? 1 : 0;
          for (let i = 0; i < songOut.length; i++)
            songError = Math.max(songError, Math.abs(songOut[i] - (songExpected[i] ?? 0)));
          chimeraSpeaker.free();

          const { loadCreatures } = await import(`${origin}/creatures.js`);
          const creatures = await loadCreatures();
          const creature = creatures.create(creatures.list[0].id);
          const cry: Float32Array = creature.call(creatures.list[0].calls[0].id);
          let creaturePeak = 0;
          for (const x of cry) creaturePeak = Math.max(creaturePeak, Math.abs(x));
          creature.free();

          const { systemVoices } = await import(`${origin}/web-speech.js`);
          const listed = await systemVoices(speechSynthesis, 500);
          return {
            loadMs,
            renderedSeconds: audio.length / sampleRate,
            exact: { maxError, trailingMax, underruns: exactEnd.underruns },
            resampled: {
              rate,
              lengthRatio: last / expected,
              rmsRatio: rms(resampledOut, expected) / rms(audio, audio.length),
              underruns: resampledEnd.underruns,
            },
            systemVoices: listed.length,
            worker: { maxError: workerError, length: at, firstChunkMs },
            say: {
              maxError: sayError,
              tokensMaxError: tokensError,
              clauses: parts2.length,
              underruns: sayEnd.underruns,
              stoppedPeak,
            },
            speaker: {
              id: chimeraSpeaker.id,
              lost: speakerRendered?.lost ?? ["render missing"],
              renderError: speakerRenderError,
              sayError: speakerSayError,
              stoppedPeak: speakerStoppedPeak,
            },
            creature: { kinds: creatures.list.length, samples: cry.length, peak: creaturePeak },
            song: {
              lost: sung.lost,
              sayError: songError,
            },
          };
        },
        { origin: ORIGIN },
      );

      // intone/live, on its own page navigated straight to the real loopback server (see the
      // comment on `liveServer` above for why it can't share ORIGIN's page): through the real
      // AudioWorkletNode + addModule pipeline, not just the bare engine the bun tests exercise.
      // Offline, so it's sample-accurate and needs no audio device (a real, non-offline
      // AudioContext has no device to attach to in a headless browser either, and hangs rather
      // than erroring; the CPU-share and real-time-hold numbers in the final report come from
      // `bun eval/budget.ts` against the bare engine).
      await page.goto(`${LIVE_ORIGIN}/`, { waitUntil: "load" });
      const live: Result["live"] = await page.evaluate(
        async ({ origin }) => {
          const { createInstrument } = await import(`${origin}/live.js`);
          const workletUrl = `${origin}/worklet-live.js`;
          const liveRate = 48_000;
          const liveOfflineContext = new OfflineAudioContext(1, Math.round(liveRate * 0.4), liveRate);
          const liveOffline = await createInstrument({ context: liveOfflineContext, worklet: workletUrl });
          liveOffline.setBody("female");
          liveOffline.noteOn(60);
          liveOffline.vowel("a");
          liveOffline.beat.steps("kick . snare .");
          liveOffline.beat.start({ bpm: 240 });
          // The control messages above cross to the worklet thread by postMessage, asynchronously;
          // give them a moment to land before telling the (otherwise instant) OfflineAudioContext to
          // render, or it may compute block 0 from a still-silent, still-unconfigured engine.
          await new Promise((resolve) => setTimeout(resolve, 50));
          const liveOfflineOut = (await liveOfflineContext.startRendering()).getChannelData(0);
          liveOffline.free();
          let liveFirst = -1;
          let livePeak = 0;
          let liveFinite = true;
          for (let i = 0; i < liveOfflineOut.length; i++) {
            const x = liveOfflineOut[i] ?? 0;
            if (!Number.isFinite(x)) liveFinite = false;
            livePeak = Math.max(livePeak, Math.abs(x));
            if (liveFirst < 0 && Math.abs(x) > 1e-3) liveFirst = i;
          }
          // The beatbox alone, no held note, to isolate its own output. A window longer than
          // `BeatPlayer::HORIZON` (0.2 s: the lead `start()` gives the first step, in
          // crates/chimera/src/control/beat_player.rs): at exactly 0.2 s the kick lands right on
          // the window's edge, won on WebKit and lost on Chromium by a block or two.
          const liveBeatContext = new OfflineAudioContext(1, Math.round(liveRate * 0.4), liveRate);
          const liveBeat = await createInstrument({ context: liveBeatContext, worklet: workletUrl });
          liveBeat.beat.steps("kick . snare .");
          liveBeat.beat.start({ bpm: 240 });
          await new Promise((resolve) => setTimeout(resolve, 50));
          const liveBeatOut = (await liveBeatContext.startRendering()).getChannelData(0);
          liveBeat.free();
          let beatPeak = 0;
          for (const x of liveBeatOut) beatPeak = Math.max(beatPeak, Math.abs(x));
          return {
            offline: {
              firstSampleMs: liveFirst < 0 ? -1 : (liveFirst / liveRate) * 1000,
              finite: liveFinite,
              peak: livePeak,
              beatPeak,
            },
          };
        },
        { origin: LIVE_ORIGIN },
      );
      result.live = live;

      const problems = [
        ...errors.map((e) => `page error: ${e}`),
        result.exact.maxError > 1e-6 && `played samples differ from render by ${result.exact.maxError}`,
        result.exact.trailingMax > 0 && "sound after the end of the utterance",
        result.exact.underruns > 0 && `${result.exact.underruns} underruns`,
        Math.abs(result.resampled.lengthRatio - 1) > 0.01 &&
          `resampled length ratio ${result.resampled.lengthRatio}`,
        Math.abs(result.resampled.rmsRatio - 1) > 0.05 &&
          `resampled level ratio ${result.resampled.rmsRatio}`,
        result.worker.maxError > 0 && `the worker's samples differ from render by ${result.worker.maxError}`,
        result.say.maxError > 0 &&
          `say from the worker differs from speech() on the page by ${result.say.maxError}`,
        result.say.tokensMaxError > 0 &&
          `say with tokens differs from speech() on the page by ${result.say.tokensMaxError}`,
        result.say.underruns > 0 && `${result.say.underruns} underruns saying from the worker`,
        result.say.stoppedPeak > 0 && `a stopped say still sounded (peak ${result.say.stoppedPeak})`,
        result.worker.length !== Math.round(result.renderedSeconds * 48_000) &&
          `the worker gave ${result.worker.length} samples`,
        result.speaker.id !== "chimera" && `createSpeaker("chimera") reported id ${result.speaker.id}`,
        result.speaker.lost.length > 0 && `createSpeaker("chimera") lost ${result.speaker.lost.join(", ")}`,
        result.speaker.renderError > 0 &&
          `createSpeaker("chimera")'s render differs from createVoice's by ${result.speaker.renderError}`,
        result.speaker.sayError > 0 &&
          `createSpeaker("chimera")'s say differs from speech() by ${result.speaker.sayError}`,
        !(result.creature.kinds > 0 && result.creature.samples > 0 && result.creature.peak > 0.001) &&
          `a creature was not heard: ${JSON.stringify(result.creature)}`,
        result.song.lost.length > 0 && `a sung say lost ${result.song.lost.join(", ")}`,
        result.song.sayError > 0 && `a sung say differs from its render by ${result.song.sayError}`,
        result.speaker.stoppedPeak > 0 &&
          `createSpeaker("chimera")'s stopped say still sounded (peak ${result.speaker.stoppedPeak})`,
        !result.live.offline.finite && "intone/live produced a non-finite sample",
        result.live.offline.peak <= 1e-3 && "intone/live's held note was not heard",
        (result.live.offline.firstSampleMs < 0 || result.live.offline.firstSampleMs > 50) &&
          `intone/live's first sample took ${result.live.offline.firstSampleMs} ms`,
        result.live.offline.beatPeak <= 1e-3 && "intone/live's beatbox was not heard",
      ].filter(Boolean);
      console.log(
        `${problems.length === 0 ? "ok  " : "FAIL"} ${name} ${await browser.version()} ${JSON.stringify(result)}`,
      );
      for (const p of problems) console.log(`     ${p}`);
      if (problems.length > 0) failed = true;
    } catch (error) {
      console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      failed = true;
    } finally {
      await browser?.close();
    }
  }
} finally {
  liveServer.stop();
}
process.exit(failed ? 1 : 0);
