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
}

let failed = false;
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
    const result: Result = await page.evaluate(async (origin) => {
      const { createVoice, play } = await import(`${origin}/index.js`);
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
      for (let i = 0; i < audio.length; i++) maxError = Math.max(maxError, Math.abs(exactOut[i] - audio[i]));
      let trailingMax = 0;
      for (let i = audio.length; i < exactOut.length; i++)
        trailingMax = Math.max(trailingMax, Math.abs(exactOut[i]));

      const rate = 44_100;
      const expected = Math.round((audio.length * rate) / sampleRate);
      const resampledContext = new OfflineAudioContext(1, expected + 4096, rate);
      const resampled = play(voice.stream(text), sampleRate, { context: resampledContext, ahead: Infinity });
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
      voice.free();
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
      };
    }, ORIGIN);
    const problems = [
      ...errors.map((e) => `page error: ${e}`),
      result.exact.maxError > 1e-6 && `played samples differ from render by ${result.exact.maxError}`,
      result.exact.trailingMax > 0 && "sound after the end of the utterance",
      result.exact.underruns > 0 && `${result.exact.underruns} underruns`,
      Math.abs(result.resampled.lengthRatio - 1) > 0.01 &&
        `resampled length ratio ${result.resampled.lengthRatio}`,
      Math.abs(result.resampled.rmsRatio - 1) > 0.05 && `resampled level ratio ${result.resampled.rmsRatio}`,
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
process.exit(failed ? 1 : 0);
