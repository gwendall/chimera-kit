/** Prepared state crosses from Bun into the browser with bit-identical acoustic continuation. */
import { pathToFileURL } from "node:url";
import type { PhysicalPerformance } from "../../src/performance.js";
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { Measurement, Scenario } from "../lib/types.ts";

const ORIGIN = "https://chimera-kit.physical-state";
export const scenario: Scenario = {
  id: "physical-state",
  description: "Portable physical-state continuation across runtimes",
  smoke: true,
  async run(ctx) {
    const { createPerformanceRenderer } = await import(pathToFileURL(`${ctx.dist}/performance.js`).href);
    const input: PhysicalPerformance = {
      version: 1,
      sampleRate: 48000,
      duration: 1,
      source: { f0: 170, pressure: 8, drift: 2 },
      gestures: [
        {
          t0: 0,
          t1: 0.9,
          rampIn: 0.01,
          rampOut: 0.03,
          strength: 5,
          targets: { breath: 1.1, f0: 200, jaw: 0.7, tbX: 2.5, tbY: 6.8 },
        },
      ],
    };
    const native = await createPerformanceRenderer(input, { captureState: true });
    let state: Uint8Array, expected: Float32Array;
    try {
      while (native.position < 24000) native.next(Math.min(4096, 24000 - native.position));
      state = await native.exportState();
      const continuation = native.next(4096);
      if (!continuation) throw new Error("physical-state: no reference continuation");
      expected = continuation.slice();
    } finally {
      native.free();
    }
    const rows: Measurement[] = [];
    for (const name of ctx.browsers)
      await withBrowser(name, async (browser) => {
        const context = await browser.newContext(),
          page = await context.newPage();
        try {
          await serveDir(page, ORIGIN, ctx.dist);
          await page.route(`${ORIGIN}/probe-state.bin`, (route) =>
            route.fulfill({ body: Buffer.from(state) }),
          );
          await page.route(`${ORIGIN}/probe-expected.bin`, (route) =>
            route.fulfill({ body: Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength) }),
          );
          await page.goto(ORIGIN, { waitUntil: "load" });
          const result = await page.evaluate(
            async ({ origin, input }) => {
              const { createPerformanceRenderer } = await import(`${origin}/performance.js`);
              const state = new Uint8Array(await (await fetch(`${origin}/probe-state.bin`)).arrayBuffer());
              const expected = new Float32Array(
                await (await fetch(`${origin}/probe-expected.bin`)).arrayBuffer(),
              );
              const start = performance.now(),
                r = await createPerformanceRenderer(input, { state });
              try {
                const restoreMs = performance.now() - start,
                  position = r.position;
                const audio = r.next(4096);
                let unequal = 0;
                if (!audio || audio.length !== expected.length)
                  throw new Error("wrong state continuation length");
                for (let i = 0; i < audio.length; i++) unequal += Number(audio[i] !== expected[i]);
                return { restoreMs, position, unequal };
              } finally {
                r.free();
              }
            },
            { origin: ORIGIN, input },
          );
          rows.push(
            {
              name: `physical-state.${name}.unequalSamples`,
              value: result.unequal,
              unit: "",
              threshold: 0,
              pass: result.unequal === 0,
            },
            {
              name: `physical-state.${name}.positionError`,
              value: Math.abs(result.position - 24000),
              unit: "samples",
              threshold: 0,
              pass: result.position === 24000,
            },
            { name: `physical-state.${name}.restoreMs`, value: result.restoreMs, unit: "ms" },
            {
              name: `physical-state.${name}.gzipBytes`,
              value: Bun.gzipSync(new Uint8Array(state)).length,
              unit: "bytes",
            },
          );
        } finally {
          await context.close();
        }
      });
    return rows;
  },
};
