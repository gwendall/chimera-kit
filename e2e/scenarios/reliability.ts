/**
 * Reliability in series: thousands of short utterances, watching JS heap for leaks; interrupt
 * storms; create/free loops; double free and use after free; concurrent calls on one worker
 * voice; AudioContext suspended/resumed/closed mid-stream.
 */
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { Measurement, Scenario, ScenarioContext } from "../lib/types.ts";
import { THRESHOLDS } from "../thresholds.ts";

const ORIGIN = "https://chimera-kit.e2e";
// Measured 2026-11-09 on this machine, no CPU throttle: voice.render("Hello there.") - about 1s
// of audio - takes ~280-320ms wall (RTF ~0.3, well under polyphony's 1.15 ceiling; this is
// correct render() cost, not a hang or a leak: confirmed flat across 150 consecutive calls, no
// growth). At 3000 calls that is ~850-960s, over the 600s (10-minute) full-run scenario budget by
// itself - this is what timed out the whole scenario with zero measurements kept, not a hang (see
// also `ctx.report` above, which now keeps whatever finished before a timeout). 1000 calls
// (~280-320s) leaves real margin for the rest of this scenario's steps and for a loaded machine.
const SERIES_N = 1000;
// Smoke: 150 renders took over its 2-minute budget at load average 15 (2026-11-10), with no hang;
// 50 keeps it near 15 s on an idle machine and under a minute on a loaded or slow one.
const SERIES_N_SMOKE = 50;
// Each cycle reloads the whole engine (wasm compile + the ~870 KB dictionary, gunzipped fresh
// every time): genuinely heavy, unlike a plain function call. 300 of those does not fit smoke's
// under-3-minutes budget on a shared machine, so smoke runs a much shorter loop.
const CREATE_FREE_CYCLES = 300;
const CREATE_FREE_CYCLES_SMOKE = 20;

export const scenario: Scenario = {
  id: "reliability",
  description:
    "Series of utterances (heap leak watch), interrupt storms, create/free loops, " +
    "double free, use after free, concurrent worker calls, AudioContext suspend/resume/close.",
  smoke: true,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    // Report each measurement as soon as it's known (see types.ts), so a later step hanging or
    // running long doesn't throw away the steps that already finished.
    const push = (m: Measurement) => {
      out.push(m);
      ctx.report(m);
    };
    await withBrowser("chromium", async (browser) => {
      // --precise-memory-info isn't set by default; request it so performance.memory is meaningful.
      const context = await browser.newContext();
      const page = await context.newPage();
      await serveDir(page, ORIGIN, ctx.dist);
      await page.goto(`${ORIGIN}/`, { waitUntil: "load" });

      const n = ctx.smoke ? SERIES_N_SMOKE : SERIES_N;
      ctx.log(`reliability: ${n} renders in series, watching heap`);
      const series = await page.evaluate(
        async ({ origin, n }) => {
          const { createVoice } = await import(`${origin}/index.js`);
          const voice = await createVoice({ body: "female" });
          const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
          const before = mem?.usedJSHeapSize ?? -1;
          let errors = 0;
          // An empty string is deliberately unspeakable (the engine throws "nothing to say") -
          // hostile.ts already covers that input and checks it settles clearly, not hangs. This
          // series watches for leaks and errors over legitimate repeated use, so every text here
          // must be one the engine is expected to render without error.
          const texts = ["Hello there.", "The birch canoe slid.", "A quick brown fox jumps."];
          for (let i = 0; i < n; i++) {
            try {
              const { audio } = voice.render(texts[i % texts.length] ?? "");
              if (audio.some((s: number) => !Number.isFinite(s))) errors++;
            } catch {
              errors++;
            }
          }
          // Force a few GC-friendly ticks; Chromium has no exposed gc() without --expose-gc, so this
          // is a best effort. Reading heap right after a long sync loop is naturally noisy.
          await new Promise((resolve) => setTimeout(resolve, 50));
          const after = mem?.usedJSHeapSize ?? -1;
          voice.free();
          return { before, after, errors, hasMemoryApi: mem !== undefined };
        },
        { origin: ORIGIN, n },
      );
      const heapGrowthPerCall = series.hasMemoryApi ? (series.after - series.before) / n : -1;
      push({ name: "reliability.series.count", value: n, unit: "renders" });
      push({
        name: "reliability.series.errors",
        value: series.errors,
        unit: "count",
        threshold: 0,
        pass: series.errors === 0,
      });
      if (series.hasMemoryApi) {
        push({
          name: "reliability.series.heapGrowthPerCall",
          value: heapGrowthPerCall,
          unit: "bytes",
          threshold: THRESHOLDS.reliability.heapGrowthPerCallBytes,
          pass: heapGrowthPerCall <= THRESHOLDS.reliability.heapGrowthPerCallBytes,
          note: `heap ${series.before} -> ${series.after}`,
        });
      } else {
        push({
          name: "reliability.series.heapGrowthPerCall",
          value: -1,
          unit: "n/a",
          note: "performance.memory unavailable in this browser",
        });
      }

      const cycles = ctx.smoke ? CREATE_FREE_CYCLES_SMOKE : CREATE_FREE_CYCLES;
      const headN = Math.min(10, Math.floor(cycles / 2));
      ctx.log(`reliability: create/free loop (direct voice), ${cycles} cycles`);
      const createFree = await page.evaluate(
        async ({ origin, cycles, headN }) => {
          const { createVoice } = await import(`${origin}/index.js`);
          const times: number[] = [];
          for (let i = 0; i < cycles; i++) {
            const t = performance.now();
            const v = await createVoice({ body: "female" });
            v.free();
            times.push(performance.now() - t);
          }
          const firstAvg = times.slice(0, headN).reduce((a, b) => a + b, 0) / headN;
          const lastAvg = times.slice(-headN).reduce((a, b) => a + b, 0) / headN;
          return { firstAvg, lastAvg };
        },
        { origin: ORIGIN, cycles, headN },
      );
      push({
        name: "reliability.createFreeLoop.driftRatio",
        value: createFree.lastAvg / createFree.firstAvg,
        unit: "x",
        threshold: THRESHOLDS.reliability.createFreeDriftRatio,
        pass: createFree.lastAvg / createFree.firstAvg <= THRESHOLDS.reliability.createFreeDriftRatio,
        note: `first${headN} ${createFree.firstAvg.toFixed(2)}ms, last${headN} ${createFree.lastAvg.toFixed(2)}ms over ${cycles} cycles`,
      });

      ctx.log("reliability: double free and use after free");
      const freeChecks = await page.evaluate(async (origin) => {
        const { createVoice } = await import(`${origin}/index.js`);
        const voice = await createVoice({ body: "female" });
        voice.free();
        let doubleFreeThrew = false;
        try {
          voice.free();
        } catch {
          doubleFreeThrew = true;
        }
        let useAfterFreeThrew = false;
        try {
          voice.render("Hello there.");
        } catch {
          useAfterFreeThrew = true;
        }
        return { doubleFreeOk: !doubleFreeThrew, useAfterFreeThrew };
      }, ORIGIN);
      push({
        name: "reliability.doubleFree.isNoOp",
        value: freeChecks.doubleFreeOk ? 1 : 0,
        unit: "bool",
        threshold: 1,
        pass: freeChecks.doubleFreeOk,
        note: "a second free() must not throw",
      });
      push({
        name: "reliability.useAfterFree.throwsClearly",
        value: freeChecks.useAfterFreeThrew ? 1 : 0,
        unit: "bool",
        threshold: 1,
        pass: freeChecks.useAfterFreeThrew,
      });

      if (!ctx.smoke) {
        ctx.log("reliability: interrupt storm (worker voice, speak over speak)");
        const storm = await page.evaluate(async (origin) => {
          const { createWorkerVoice } = await import(`${origin}/index.js`);
          const voice = await createWorkerVoice({ body: "female" });
          let errors = 0;
          const playbacks: ReturnType<typeof voice.say>[] = [];
          for (let i = 0; i < 40; i++) {
            try {
              const p = voice.say("The birch canoe slid on the smooth planks.");
              playbacks.push(p);
              if (i % 3 === 0) p.stop();
              if (i % 7 === 0 && playbacks.length > 1) playbacks[playbacks.length - 2]?.stop();
            } catch {
              errors++;
            }
          }
          // Measured ~21s to settle on its own (40 real-time worker.say() calls, several stopped
          // mid-flight) - the previous 10s race ceiling reported a false "hang" on a healthy run.
          const settled = await Promise.race([
            Promise.allSettled(playbacks.map((p) => p.done)).then(() => "settled"),
            new Promise((resolve) => setTimeout(() => resolve("hang"), 45_000)),
          ]);
          voice.free();
          return { errors, settled };
        }, ORIGIN);
        push({
          name: "reliability.interruptStorm.errors",
          value: storm.errors,
          unit: "count",
          threshold: 0,
          pass: storm.errors === 0,
        });
        push({
          name: "reliability.interruptStorm.allSettled",
          value: storm.settled === "hang" ? 0 : 1,
          unit: "bool",
          threshold: 1,
          pass: storm.settled !== "hang",
        });

        ctx.log("reliability: concurrent calls on one worker voice stay correct");
        const concurrent = await page.evaluate(async (origin) => {
          const { createWorkerVoice } = await import(`${origin}/index.js`);
          const voice = await createWorkerVoice({ body: "female" });
          const text = "The birch canoe slid on the smooth planks.";
          const serial = (await voice.render(text)).audio;
          const concurrentResults = await Promise.all(Array.from({ length: 16 }, () => voice.render(text)));
          voice.free();
          let maxError = 0;
          for (const r of concurrentResults) {
            if (r.audio.length !== serial.length) {
              maxError = Number.POSITIVE_INFINITY;
              continue;
            }
            for (let i = 0; i < serial.length; i++)
              maxError = Math.max(maxError, Math.abs(r.audio[i] - serial[i]));
          }
          return { maxError, count: concurrentResults.length };
        }, ORIGIN);
        push({
          name: "reliability.concurrentWorkerCalls.maxError",
          value: concurrent.maxError,
          unit: "sample delta",
          threshold: 0,
          pass: concurrent.maxError === 0,
          note: `${concurrent.count} concurrent render() calls on one worker voice vs serial baseline`,
        });

        ctx.log("reliability: AudioContext suspend/resume/close mid-stream");
        const audioContextCases = await page.evaluate(async (origin) => {
          const { createVoice, play } = await import(`${origin}/index.js`);
          const voice = await createVoice({ body: "female" });
          // play() through an AudioContext is real-time playback, not synthesis time: repeat(20)
          // (161 words) measured ~54s to resolve on its own, well past the 10s race ceiling below
          // - that was reporting a false "hang" on perfectly healthy playback, not a real one.
          // repeat(8) (64 words, ~22s at the same rate) still gives the suspend (at 60ms in) and
          // the 150ms pause plenty of in-flight stream to interrupt, for much less wall time.
          const longText = "The birch canoe slid on the smooth planks. ".repeat(8);
          // Measured headroom above the ~22s expected settle time, generous for a loaded machine.
          const SETTLE_CEILING_MS = 60_000;

          // Suspend then resume mid-stream: must not hang or throw unhandled.
          const ctxA = new AudioContext();
          const pbA = play(voice.stream(longText), voice.sampleRate, { context: ctxA });
          await new Promise((resolve) => setTimeout(resolve, 60));
          await ctxA.suspend();
          await new Promise((resolve) => setTimeout(resolve, 150));
          await ctxA.resume();
          const suspendResumeOutcome = await Promise.race([
            pbA.done.then(() => "resolved").catch((e: unknown) => `rejected: ${e}`),
            new Promise((resolve) => setTimeout(() => resolve("hang"), SETTLE_CEILING_MS)),
          ]);
          if (suspendResumeOutcome === "hang") pbA.stop();
          await ctxA.close().catch(() => {});

          // Context closed mid-stream: must settle (resolve or reject), never hang.
          const ctxB = new AudioContext();
          const pbB = play(voice.stream(longText), voice.sampleRate, { context: ctxB });
          await new Promise((resolve) => setTimeout(resolve, 60));
          await ctxB.close();
          const closedMidStreamOutcome = await Promise.race([
            pbB.done.then(() => "resolved").catch((e: unknown) => `rejected: ${e}`),
            new Promise((resolve) => setTimeout(() => resolve("hang"), SETTLE_CEILING_MS)),
          ]);
          voice.free();
          return { suspendResumeOutcome, closedMidStreamOutcome };
        }, ORIGIN);
        push({
          name: "reliability.audioContext.suspendResumeMidStream",
          value: audioContextCases.suspendResumeOutcome === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: audioContextCases.suspendResumeOutcome !== "hang",
          note: audioContextCases.suspendResumeOutcome,
        });
        push({
          name: "reliability.audioContext.closedMidStream",
          value: audioContextCases.closedMidStreamOutcome === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: audioContextCases.closedMidStreamOutcome !== "hang",
          note: audioContextCases.closedMidStreamOutcome,
        });
      }
      await context.close();
    });
    return out;
  },
};
