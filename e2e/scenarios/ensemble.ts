/** A real six-voice concert transport: common clock, heard telemetry, pause and exact seek. */
import type { Ensemble } from "../../src/ensemble.js";
import type { PhysicalPerformance } from "../../src/performance.js";
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { Measurement, Scenario } from "../lib/types.ts";

type Probe = typeof window & {
  ensemble: Ensemble;
  playError: string | null;
  peak: number;
  stopMeter(): void;
};
const ORIGIN = "https://chimera-kit.ensemble";
export const scenario: Scenario = {
  id: "ensemble",
  description: "Continuous six-voice transport, pause, seek and heard physical state",
  smoke: true,
  async run(ctx) {
    const rows: Measurement[] = [];
    for (const name of ctx.browsers) {
      await withBrowser(name, async (browser) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        try {
          await serveDir(page, ORIGIN, ctx.dist, { index: "<!doctype html><button>Play</button>" });
          await page.goto(ORIGIN, { waitUntil: "load" });
          await page.evaluate(async (origin) => {
            const { createEnsemble } = await import(`${origin}/ensemble.js`);
            const parts = Array.from({ length: 6 }, (_, i) => {
              const gestures: PhysicalPerformance["gestures"] = [];
              for (let k = 0; k < 1000; k++)
                gestures.push({
                  t0: k / 100,
                  t1: (k + 1) / 100,
                  rampIn: 0.005,
                  rampOut: 0.005,
                  strength: 5,
                  targets: { f0: 140 + i * 20 + 12 * Math.sin(k / 50), breath: 1.1 },
                });
              gestures.push({
                t0: 0,
                t1: 10,
                rampIn: 0.02,
                rampOut: 0.02,
                strength: 5,
                targets: { jaw: 0.6, tbX: 2.5, tbY: 6.8, lipAp: 0.8 },
              });
              return {
                id: String(i),
                gain: 0.03,
                performance: {
                  version: 1,
                  sampleRate: 48000,
                  duration: 10,
                  body: "male",
                  source: { drift: 0 },
                  gestures,
                },
              };
            });
            const ensemble = await createEnsemble(parts, { workers: 6, ahead: 2 });
            const probe = window as Probe;
            probe.ensemble = ensemble;
            probe.playError = null;
            probe.peak = 0;
            const meter = ensemble.context.createAnalyser();
            for (const output of ensemble.outputs.values()) output.connect(meter);
            const pcm = new Float32Array(meter.fftSize);
            let raf = 0;
            const tick = () => {
              meter.getFloatTimeDomainData(pcm);
              for (const x of pcm) probe.peak = Math.max(probe.peak, Math.abs(x));
              raf = requestAnimationFrame(tick);
            };
            tick();
            probe.stopMeter = () => {
              cancelAnimationFrame(raf);
              meter.disconnect();
            };
            document.querySelector("button")?.addEventListener("click", () => {
              const first = ensemble.play();
              probe.sharedPlayTask = first === ensemble.play();
              void first.catch((error: Error) => {
                probe.playError = error.message;
              });
            });
          }, ORIGIN);
          await page.click("button");
          await page.waitForFunction(
            () => (window as Probe).ensemble.isPlaying || (window as Probe).playError,
            { timeout: 15000 },
          );
          await page.waitForTimeout(1700);
          const result = await page.evaluate(async () => {
            const p = window as Probe,
              e = p.ensemble;
            const heard = e.time(),
              physical = e.telemetry("0")?.clock ?? Infinity;
            e.pause();
            const paused = e.time();
            await new Promise((r) => setTimeout(r, 100));
            const drift = Math.abs(e.time() - paused);
            await e.seek(1.25);
            const seekError = Math.abs(e.time() - 1.25);
            await e.play();
            await new Promise((r) => setTimeout(r, 500));
            return {
              ...e.state,
              drift,
              seekError,
              telemetryLag: heard - physical,
              peak: p.peak,
              playError: p.playError,
              sharedPlayTask: p.sharedPlayTask,
            };
          });
          const add = (metric: string, value: number, threshold: number, pass: boolean) =>
            rows.push({ name: `ensemble.${name}.${metric}`, value, unit: "", threshold, pass });
          add("lateBlocks", result.underruns, 0, result.underruns === 0);
          add("duplicateStarts", result.sharedPlayTask ? 0 : 1, 0, result.sharedPlayTask);
          add("pauseDrift", result.drift, 0, result.drift === 0);
          add("seekError", result.seekError, 0.000001, result.seekError < 0.000001);
          add(
            "heardTelemetryLag",
            result.telemetryLag,
            0.05,
            result.telemetryLag >= -0.001 && result.telemetryLag < 0.05,
          );
          add("audible", result.peak, 0, result.peak > 0 && Number.isFinite(result.peak));
          add(
            "playErrors",
            result.playError ? 1 : 0,
            0,
            !result.playError && !result.error && result.playing,
          );
        } finally {
          await page
            .evaluate(() => {
              const p = window as Partial<Probe>;
              p.stopMeter?.();
              p.ensemble?.free();
            })
            .catch(() => {});
          await context.close();
        }
      });
    }
    return rows;
  },
};
