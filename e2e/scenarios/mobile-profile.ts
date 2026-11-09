/**
 * Every browser available, plus a mobile profile: Playwright's iPhone device descriptor (viewport,
 * user agent, touch) on every engine, with CPU throttling added on chromium (the one engine that
 * exposes it over CDP).
 */
import { devices } from "playwright-core";
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { BrowserName, Measurement, Scenario, ScenarioContext } from "../lib/types.ts";
import { THRESHOLDS } from "../thresholds.ts";

const ORIGIN = "https://intone.e2e";

export const scenario: Scenario = {
  id: "mobile-profile",
  description:
    "Loads under a mobile device profile (viewport, UA, touch) on every available " +
    "browser engine, with CPU x4 throttling added on chromium.",
  smoke: false,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    const device = devices["iPhone 13"];
    for (const name of ctx.browsers as BrowserName[]) {
      ctx.log(`mobile-profile: ${name}`);
      await withBrowser(name, async (browser) => {
        const context = await browser.newContext({ ...device });
        const page = await context.newPage();
        await serveDir(page, ORIGIN, ctx.dist);
        if (name === "chromium") {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        }
        await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
        const r = await page.evaluate(async (origin) => {
          const t0 = performance.now();
          const { createVoice } = await import(`${origin}/index.js`);
          const voice = await createVoice({ body: "female" });
          const createVoiceMs = performance.now() - t0;
          let firstAudibleMs = -1;
          const started = performance.now();
          for (const chunk of voice.stream("Hello there.")) {
            if (chunk.some((s: number) => Math.abs(s) > 1e-3)) {
              firstAudibleMs = performance.now() - started;
              break;
            }
          }
          voice.free();
          return {
            createVoiceMs,
            firstAudibleMs,
            hasAudioWorklet: typeof AudioWorkletNode !== "undefined",
            touch: "ontouchstart" in window,
          };
        }, ORIGIN);
        await context.close();
        out.push(
          {
            name: `mobileProfile.${name}.createVoiceMs`,
            value: r.createVoiceMs,
            unit: "ms",
            threshold: THRESHOLDS.mobile.createVoiceMs,
            pass: r.createVoiceMs <= THRESHOLDS.mobile.createVoiceMs,
          },
          {
            name: `mobileProfile.${name}.firstAudibleMs`,
            value: r.firstAudibleMs,
            unit: "ms",
            threshold: THRESHOLDS.mobile.firstAudibleMs,
            pass: r.firstAudibleMs >= 0 && r.firstAudibleMs <= THRESHOLDS.mobile.firstAudibleMs,
          },
          {
            name: `mobileProfile.${name}.audioWorkletSupported`,
            value: r.hasAudioWorklet ? 1 : 0,
            unit: "bool",
            threshold: 1,
            pass: r.hasAudioWorklet,
          },
        );
      });
    }
    return out;
  },
};
