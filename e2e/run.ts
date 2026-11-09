#!/usr/bin/env bun
/**
 * The intone e2e harness: installs and integration, load, reliability, hostile inputs and
 * environments, polyphony to the breaking point, and the browser matrix, for the Next.js site in
 * `site/` and the library behind it.
 *
 *   bun e2e/run.ts [--scenario <glob>] [--browser chromium,firefox,webkit] [--smoke] [--json <path>]
 *
 * Prints a compact table and writes `e2e/out/report.json` and `e2e/out/report.md` (or the path
 * given with --json, whose .md sibling gets the Markdown report).
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { closeAllBrowsers, forgetAllBrowsers } from "./lib/browsers.ts";
import { printTable, type ScenarioReport, writeJson, writeMarkdown } from "./lib/report.ts";
import { calibrate } from "./lib/sys.ts";
import type { BrowserName, Measurement, ScenarioContext } from "./lib/types.ts";

// Never leaves a run hanging on a shared machine: a hard ceiling on the whole process.
const GLOBAL_BUDGET_MS = 30 * 60_000;
setTimeout(() => {
  console.error("e2e/run.ts: over its 30-minute global budget, exiting");
  process.exit(1);
}, GLOBAL_BUDGET_MS).unref();

// Playwright does not reject a pending page.evaluate() when the renderer crashes or the browser
// otherwise dies mid-call -- it just hangs forever (seen live: a reliability run's create/free
// loop left no chrome-headless-shell process running at all, yet `await s.run(ctx)` never
// returned). One scenario's own GUARD_MS races inside it, but a hang before ever reaching a race
// -- or one the race itself can't see, like the browser dying -- would otherwise eat the whole
// global budget silently. Each scenario gets its own ceiling instead: tight for --smoke (it must
// stay well under 3 minutes total), generous for a full run (polyphony alone budgets 90s per mode
// across up to 3 modes, plus install/build scenarios that shell out to real package managers).
const SCENARIO_BUDGET_MS_SMOKE = 2 * 60_000;
const SCENARIO_BUDGET_MS_FULL = 10 * 60_000;

/** Children of this process named like a Playwright browser: ours, never another session's. */
async function killOwnBrowserChildren(): Promise<string[]> {
  const ps = Bun.spawn(["ps", "-eo", "pid,ppid,command"], { stdout: "pipe" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  const killed: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, command] = m;
    if (Number(ppid) !== process.pid) continue;
    if (!/chrome-headless-shell|firefox|webkit|minidump_stackwalk/.test(command ?? "")) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
      killed.push(`${pid} (${(command ?? "").slice(0, 60)})`);
    } catch {
      // already gone
    }
  }
  return killed;
}

/**
 * Runs one scenario with a hard wall-clock ceiling, so a hang reports as a failure, not a stall.
 * `partial` collects whatever the scenario already reported via `ctx.report` before a timeout, so
 * the caller can keep those measurements instead of losing the whole scenario to zero rows.
 */
async function runWithBudget(
  s: { run(ctx: ScenarioContext): Promise<Measurement[]> },
  ctx: ScenarioContext,
  partial: Measurement[],
): Promise<Measurement[]> {
  const budgetMs = ctx.smoke ? SCENARIO_BUDGET_MS_SMOKE : SCENARIO_BUDGET_MS_FULL;
  const result = await Promise.race([
    s
      .run(ctx)
      .then((m): { timedOut: false; measurements: Measurement[] } => ({ timedOut: false, measurements: m })),
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), budgetMs)),
  ]);
  if (result.timedOut) {
    const killed = await killOwnBrowserChildren();
    // The process's shared browser (see lib/browsers.ts) may now be dead or wedged; drop it so
    // the next scenario launches fresh instead of reusing a handle that will hang forever too.
    forgetAllBrowsers();
    throw new Error(
      `scenario exceeded its ${budgetMs / 60_000}-minute budget (hung, not just slow -- ` +
        `a Playwright page.evaluate() does not reject on its own when the browser dies mid-call). ` +
        (killed.length > 0
          ? `Killed leaked browser process(es): ${killed.join(", ")}.`
          : "No leaked browser process found to kill.") +
        (partial.length > 0
          ? ` ${partial.length} measurement(s) from steps that finished before the timeout are kept below.`
          : " No step had reported a measurement yet."),
    );
  }
  return result.measurements;
}

const ROOT = join(import.meta.dir, "..");

function parseArgs(argv: string[]) {
  let scenario: string | undefined;
  let browsers: BrowserName[] = ["chromium", "firefox", "webkit"];
  let smoke = false;
  let json: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenario") scenario = argv[++i];
    else if (a === "--browser") browsers = (argv[++i] ?? "").split(",").filter(Boolean) as BrowserName[];
    else if (a === "--smoke") smoke = true;
    else if (a === "--json") json = argv[++i];
  }
  return { scenario, browsers, smoke, json };
}

function matches(id: string, glob: string | undefined): boolean {
  if (!glob) return true;
  const pattern = `^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`;
  return new RegExp(pattern).test(id);
}

async function main() {
  const { scenario: scenarioGlob, browsers, smoke, json } = parseArgs(process.argv.slice(2));
  const dist = join(ROOT, "dist");
  if (!(await Bun.file(join(dist, "index.js")).exists())) {
    console.error("e2e: no dist/index.js. Run `bun run build` at the repository's root first.");
    process.exit(1);
  }

  const tmp = join(import.meta.dir, "tmp", `run-${Date.now()}`);
  await mkdir(tmp, { recursive: true });

  const modules = await Promise.all(
    [
      "./scenarios/load.ts",
      "./scenarios/reliability.ts",
      "./scenarios/hostile.ts",
      "./scenarios/polyphony.ts",
      "./scenarios/install-integration.ts",
      "./scenarios/mobile-profile.ts",
      "./scenarios/site-production.ts",
    ].map((p) => import(p)),
  );
  const all = modules.map((m) => m.scenario);
  const chosen = all.filter((s) => matches(s.id, scenarioGlob) && (!smoke || s.smoke));

  console.log(
    `intone e2e: ${chosen.length} scenario(s)${smoke ? " (smoke)" : ""}: ${chosen.map((s) => s.id).join(", ")}`,
  );
  const calibration = await calibrate();
  console.log(calibration.uptimeLine);

  const reports: ScenarioReport[] = [];
  const runStarted = performance.now();
  for (const s of chosen) {
    const partial: Measurement[] = [];
    const ctx: ScenarioContext = {
      browsers,
      smoke,
      root: ROOT,
      dist,
      tmp,
      log: (line: string) => console.log(`  ... ${line}`),
      report: (m: Measurement) => partial.push(m),
    };
    console.log(`\n=== ${s.id} ===`);
    const started = performance.now();
    try {
      const measurements = await runWithBudget(s, ctx, partial);
      const ok = measurements.every((m: Measurement) => m.pass !== false);
      reports.push({
        id: s.id,
        description: s.description,
        ok,
        measurements,
        durationMs: performance.now() - started,
      });
    } catch (error) {
      reports.push({
        id: s.id,
        description: s.description,
        ok: false,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        // Keep whatever steps finished before the timeout/error instead of reporting zero rows.
        measurements: partial,
        durationMs: performance.now() - started,
      });
    }
  }

  const report = {
    startedAt: new Date().toISOString(),
    calibration,
    browsers,
    smoke,
    scenarios: reports,
    totalDurationMs: performance.now() - runStarted,
    ok: reports.every((r) => r.ok),
  };

  printTable(report);
  const jsonPath = json ?? join(import.meta.dir, "out", "report.json");
  const mdPath = jsonPath.replace(/\.json$/, ".md");
  await writeJson(jsonPath, report);
  await writeMarkdown(mdPath, report);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);

  await closeAllBrowsers().catch((error: unknown) => {
    console.error(
      `e2e: closing browsers at shutdown: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await rm(tmp, { recursive: true, force: true });
  process.exit(report.ok ? 0 : 1);
}

await main();
