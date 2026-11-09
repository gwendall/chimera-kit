/**
 * The real site (`site/`), built for production and driven like a visitor: load, wait for the
 * engine to report ready, click "Speak", wait for it to finish, with no console errors. Only
 * builds and reads `site/`; never edits it (another agent owns its metadata and Vercel config
 * right now).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { withBrowser } from "../lib/browsers.ts";
import { run } from "../lib/exec.ts";
import { serveDir } from "../lib/serve.ts";
import type { Measurement, Scenario, ScenarioContext } from "../lib/types.ts";
import { THRESHOLDS } from "../thresholds.ts";

export const scenario: Scenario = {
  id: "site-production",
  description:
    "Builds site/ for production (output: export) and drives it like a visitor: load, " +
    "ready, click Speak, hear it finish.",
  smoke: false,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    const siteDir = join(ctx.root, "site");
    ctx.log("site-production: bun run build (sync + next build)");
    const build = await run(["bun", "run", "build"], { cwd: siteDir, timeoutMs: 180_000 });
    out.push({
      name: "site.build.ok",
      value: build.code === 0 ? 1 : 0,
      unit: "bool",
      threshold: 1,
      pass: build.code === 0,
      note: build.code === 0 ? undefined : build.stderr.slice(-2000),
    });
    out.push({ name: "site.build.ms", value: build.ms, unit: "ms" });
    if (build.code !== 0) return out;

    const outDir = join(siteDir, "out");
    const entries = await readdir(outDir).catch((): string[] => []);
    if (!entries.includes("index.html")) {
      out.push({
        name: "site.build.hasIndexHtml",
        value: 0,
        unit: "bool",
        threshold: 1,
        pass: false,
        note: `out/ has: ${entries.join(", ")}`,
      });
      return out;
    }

    await withBrowser("chromium", async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on("pageerror", (e) => consoleErrors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      const origin = "https://intone.site";
      // serveDir's "/" default is a blank placeholder page (see its doc comment) - a visitor of
      // the real production site gets the real exported index.html, so this scenario must hand
      // that in explicitly. Without it, `.go` never exists, the readiness wait always times out,
      // and (see below) it silently timed out at Playwright's 30s default instead of the 10s this
      // scenario asked for.
      const index = await Bun.file(join(outDir, "index.html")).text();
      await serveDir(page, origin, outDir, { index });
      const navStart = performance.now();
      await page.goto(`${origin}/`, { waitUntil: "load" });
      let ready = false;
      try {
        // page.waitForFunction(fn, arg, options) - `arg` is passed INTO the page function, not
        // "the options if you only gave two arguments". `waitForFunction(fn, { timeout })` was
        // silently sending `{ timeout: 10_000 }` as `arg` (ignored, the function takes none) and
        // falling back to Playwright's own default timeout (30s), not the 10s this line asked
        // for - measured live: a wait that should give up at 10s instead reported readyMs
        // ~30021ms, which is exactly Playwright's 30000ms default plus overhead. The explicit
        // `undefined` below is the real `arg`; `options` is the third positional parameter.
        await page.waitForFunction(() => document.querySelector(".go")?.textContent === "Speak", undefined, {
          timeout: 10_000,
        });
        ready = true;
      } catch {
        ready = false;
      }
      const readyMs = performance.now() - navStart;
      out.push({
        name: "site.visitor.readyMs",
        value: readyMs,
        unit: "ms",
        threshold: THRESHOLDS.site.readyMs,
        pass: ready && readyMs <= THRESHOLDS.site.readyMs,
      });
      if (ready) {
        const clickStart = performance.now();
        await page.click(".go");
        let spoke = false;
        try {
          // Same arg/options fix as above.
          await page.waitForFunction(() => document.querySelector(".go")?.textContent === "Stop", undefined, {
            timeout: 5000,
          });
          await page.waitForFunction(() => document.querySelector(".go")?.textContent !== "Stop", undefined, {
            timeout: 15_000,
          });
          spoke = true;
        } catch {
          spoke = false;
        }
        out.push({
          name: "site.visitor.speakRoundTripMs",
          value: performance.now() - clickStart,
          unit: "ms",
        });
        out.push({
          name: "site.visitor.speakCompleted",
          value: spoke ? 1 : 0,
          unit: "bool",
          threshold: 1,
          pass: spoke,
        });
      }
      out.push({
        name: "site.visitor.consoleErrors",
        value: consoleErrors.length,
        unit: "count",
        threshold: 0,
        pass: consoleErrors.length === 0,
        note: consoleErrors[0],
      });
      await context.close();
    });
    return out;
  },
};
