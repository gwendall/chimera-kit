/**
 * Cold and cached `createVoice`: bytes transferred, wasm compile time, dictionary time, time to
 * first sample and first audible output. Chromium also runs this under CDP network and CPU
 * throttling, since that is the one engine Playwright can throttle this way.
 */
import type { CDPSession } from "playwright-core";
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { BrowserName, Measurement, Scenario, ScenarioContext } from "../lib/types.ts";
import { THRESHOLDS } from "../thresholds.ts";

const ORIGIN = "https://chimera-kit.e2e";

interface Net {
  label: string;
  downloadKbps: number;
  uploadKbps: number;
  latencyMs: number;
}
// Chrome DevTools-style presets (not live network, so these are nominal, not measured over a wire).
const NETWORKS: Net[] = [
  { label: "fast4g", downloadKbps: 9000, uploadKbps: 1500, latencyMs: 40 },
  { label: "slow3g", downloadKbps: 400, uploadKbps: 400, latencyMs: 400 },
];
const CPU_RATES = [4, 6];

interface PageResult {
  bytesTransferred: number;
  wasmCompileMs: number;
  dictionaryMs: number;
  createVoiceMs: number;
  firstSampleMs: number;
  firstAudibleMs: number;
}

async function measureOnce(
  browserName: BrowserName,
  withThrottle: ((cdp: CDPSession) => Promise<void>) | undefined,
  ctx: ScenarioContext,
): Promise<PageResult> {
  return withBrowser(browserName, async (browser) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let bytes = 0;
    page.on("response", async (res) => {
      try {
        const body = await res.body();
        bytes += body.length;
      } catch {
        // navigation/document response bodies can race the page closing; not worth failing on.
      }
    });
    await serveDir(page, ORIGIN, ctx.dist, {
      headers: { "Cache-Control": "public, max-age=31536000" },
    });
    if (withThrottle && browserName === "chromium") {
      const cdp = await context.newCDPSession(page);
      await withThrottle(cdp);
    }
    await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
    const result = await page.evaluate(async (origin) => {
      const t0 = performance.now();
      const { createVoice } = await import(`${origin}/index.js`);
      const voice = await createVoice({ body: "female" });
      const createVoiceMs = performance.now() - t0;
      let firstSampleMs = -1;
      const started = performance.now();
      for (const chunk of voice.stream("Hello there.")) {
        if (chunk.length > 0) {
          firstSampleMs = performance.now() - started;
          break;
        }
      }
      let firstAudibleMs = -1;
      const started2 = performance.now();
      for (const chunk of voice.stream("Hello there.")) {
        if (chunk.some((s: number) => Math.abs(s) > 1e-3)) {
          firstAudibleMs = performance.now() - started2;
          break;
        }
      }
      voice.free();
      const marks = performance.getEntriesByType("mark");
      const of = (name: string) => marks.find((m) => m.name === name)?.startTime ?? -1;
      return {
        createVoiceMs,
        firstSampleMs,
        firstAudibleMs,
        wasmMark: of("chimera-kit:wasm"),
        dictMark: of("chimera-kit:dict"),
      };
    }, ORIGIN);
    await context.close();
    return {
      bytesTransferred: bytes,
      // The engine does not currently emit its own marks (see finding below); -1 means "not observed".
      wasmCompileMs: result.wasmMark,
      dictionaryMs: result.dictMark,
      createVoiceMs: result.createVoiceMs,
      firstSampleMs: result.firstSampleMs,
      firstAudibleMs: result.firstAudibleMs,
    };
  });
}

export const scenario: Scenario = {
  id: "load",
  description:
    "Cold and cached createVoice: bytes transferred, time to first sample and first audible output, " +
    "under CDP network and CPU throttling (chromium only).",
  smoke: true,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    const browsers = ctx.smoke ? (["chromium"] as BrowserName[]) : ctx.browsers;
    for (const name of browsers) {
      ctx.log(`load: ${name} cold`);
      const cold = await measureOnce(name, undefined, ctx);
      out.push(
        {
          name: `load.${name}.cold.createVoiceMs`,
          value: cold.createVoiceMs,
          unit: "ms",
          threshold: THRESHOLDS.load.coldCreateVoiceMs,
          pass: cold.createVoiceMs <= THRESHOLDS.load.coldCreateVoiceMs,
        },
        {
          name: `load.${name}.cold.firstSampleMs`,
          value: cold.firstSampleMs,
          unit: "ms",
          threshold: THRESHOLDS.load.firstSampleMs,
          pass: cold.firstSampleMs <= THRESHOLDS.load.firstSampleMs,
        },
        {
          name: `load.${name}.cold.firstAudibleMs`,
          value: cold.firstAudibleMs,
          unit: "ms",
          threshold: THRESHOLDS.load.firstAudibleMs,
          pass: cold.firstAudibleMs <= THRESHOLDS.load.firstAudibleMs,
        },
        {
          name: `load.${name}.cold.bytesTransferred`,
          value: cold.bytesTransferred,
          unit: "bytes",
          threshold: THRESHOLDS.load.bytesTransferred,
          pass: cold.bytesTransferred <= THRESHOLDS.load.bytesTransferred,
        },
      );
      if (ctx.smoke) continue;

      ctx.log(`load: ${name} cached (second page, same context)`);
      await withBrowser(name, async (browser) => {
        const context = await browser.newContext();
        const page1 = await context.newPage();
        await serveDir(page1, ORIGIN, ctx.dist, { headers: { "Cache-Control": "public, max-age=31536000" } });
        await page1.goto(`${ORIGIN}/`, { waitUntil: "load" });
        await page1.evaluate(async (origin) => {
          const { createVoice } = await import(`${origin}/index.js`);
          (await createVoice({ body: "female" })).free();
        }, ORIGIN);
        await page1.close();
        const page2 = await context.newPage();
        await serveDir(page2, ORIGIN, ctx.dist, { headers: { "Cache-Control": "public, max-age=31536000" } });
        const t0 = performance.now();
        await page2.goto(`${ORIGIN}/`, { waitUntil: "load" });
        const cachedCreateVoiceMs = await page2.evaluate(async (origin) => {
          const t = performance.now();
          const { createVoice } = await import(`${origin}/index.js`);
          (await createVoice({ body: "female" })).free();
          return performance.now() - t;
        }, ORIGIN);
        const cachedLoadMs = performance.now() - t0;
        await context.close();
        out.push(
          {
            name: `load.${name}.cached.createVoiceMs`,
            value: cachedCreateVoiceMs,
            unit: "ms",
            threshold: THRESHOLDS.load.cachedCreateVoiceMs,
            pass: cachedCreateVoiceMs <= THRESHOLDS.load.cachedCreateVoiceMs,
          },
          { name: `load.${name}.cached.navigationMs`, value: cachedLoadMs, unit: "ms" },
        );
      });

      if (name !== "chromium") {
        out.push({
          name: `load.${name}.throttling`,
          value: 0,
          unit: "n/a",
          note: "CDP throttling is chromium-only; not run on this engine",
        });
        continue;
      }
      for (const net of NETWORKS) {
        ctx.log(`load: chromium under ${net.label}`);
        const r = await measureOnce(
          name,
          async (cdp) => {
            await cdp.send("Network.enable");
            await cdp.send("Network.emulateNetworkConditions", {
              offline: false,
              downloadThroughput: (net.downloadKbps * 1024) / 8,
              uploadThroughput: (net.uploadKbps * 1024) / 8,
              latency: net.latencyMs,
            });
          },
          ctx,
        );
        out.push({
          name: `load.chromium.${net.label}.createVoiceMs`,
          value: r.createVoiceMs,
          unit: "ms",
          threshold: THRESHOLDS.load.throttledCreateVoiceMs,
          pass: r.createVoiceMs <= THRESHOLDS.load.throttledCreateVoiceMs,
          note: `download ${net.downloadKbps}kbps, latency ${net.latencyMs}ms`,
        });
      }
      for (const rate of CPU_RATES) {
        ctx.log(`load: chromium at CPU x${rate}`);
        const r = await measureOnce(
          name,
          async (cdp) => {
            await cdp.send("Emulation.setCPUThrottlingRate", { rate });
          },
          ctx,
        );
        out.push({
          name: `load.chromium.cpu${rate}x.createVoiceMs`,
          value: r.createVoiceMs,
          unit: "ms",
          threshold: THRESHOLDS.load.cpuThrottledCreateVoiceMs,
          pass: r.createVoiceMs <= THRESHOLDS.load.cpuThrottledCreateVoiceMs,
        });
      }
    }
    return out;
  },
};
