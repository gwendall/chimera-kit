/**
 * One Playwright browser per engine for the whole run, per the machine's Playwright rule: one
 * browser per run, `browser.close()` guaranteed even on failure, never `waitUntil: 'networkidle'`.
 *
 * "One browser per run" turned out to mean exactly that: `chromium.launch()`'d a second time in
 * the same process - even cleanly closed first, even from a different scenario - left the next
 * `createVoice()` call hanging forever (no crash, no error, `page.evaluate()` just never settles;
 * see e2e/run.ts's `runWithBudget` comment). Reproduced down to the minimal case: launch, one
 * `createVoice()`+`free()`, close; launch again; the very first `createVoice()` of the second
 * browser hangs, deterministically, every time, regardless of what ran in between. So one browser
 * per *engine* is launched for the whole `bun e2e/run.ts` process and reused across every
 * scenario; each caller still gets its own fresh `BrowserContext` (a context is cheap and isolates
 * cookies/storage/routes between scenarios, which is all "one browser per run" needs). Call
 * `closeAllBrowsers()` once, at the very end of the run, success or failure.
 */
import { type Browser, chromium, firefox, webkit } from "playwright-core";
import type { BrowserName } from "./types.ts";

const ENGINES = { chromium, firefox, webkit } as const;

// A browser already installed on the system ("chrome" on CI's ubuntu-latest runners) instead of
// downloading Playwright's own binary, exactly like scripts/browser-check.ts. Only chromium has a
// "chrome" channel; firefox/webkit ignore this and always use Playwright's own build.
const CHANNEL = process.env.BROWSER_CHANNEL;

// Tracks which engines were already checked, by name - not a single flag. A single flag would
// flip true on the first `withBrowser("chromium", ...)` call and then skip the install check for
// firefox/webkit forever, even though they are different engines with their own cache entries.
const installedChecked = new Set<BrowserName>();

/** Installs Playwright's browsers if missing. Runs once per engine per process. */
export async function ensureInstalled(names: BrowserName[]): Promise<void> {
  // A system channel needs no Playwright-managed binary for that engine.
  const toCheck = names.filter((n) => !installedChecked.has(n) && !(n === "chromium" && CHANNEL));
  if (toCheck.length === 0) return;
  for (const n of toCheck) installedChecked.add(n);
  const proc = Bun.spawn(["bunx", "playwright-core", "install", ...toCheck], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`e2e: could not install browsers ${toCheck.join(", ")}: ${err.slice(-2000)}`);
  }
}

/** One launched browser per engine, reused for the whole process. See the module comment. */
const launched = new Map<BrowserName, Promise<Browser>>();

async function getBrowser(name: BrowserName): Promise<Browser> {
  const cached = launched.get(name);
  if (cached) return cached;
  await ensureInstalled([name]);
  // Headless CI validates rendered playback, not Chromium's engagement policy.
  // Keep the opt-in off for the normal browser matrix and autoplay-policy cases.
  const options = {
    ...(name === "chromium" && CHANNEL ? { channel: CHANNEL } : {}),
    ...(name === "chromium" && process.env.E2E_AUDIO_AUTOPLAY === "1"
      ? { args: ["--autoplay-policy=no-user-gesture-required"] }
      : {}),
  };
  const promise = ENGINES[name].launch(options);
  launched.set(name, promise);
  return promise;
}

/** Closes every browser launched this process. Call once, at the very end of the run. */
export async function closeAllBrowsers(): Promise<void> {
  const browsers = await Promise.allSettled([...launched.values()]);
  launched.clear();
  for (const b of browsers) if (b.status === "fulfilled") await b.value.close();
}

/**
 * Drops every cached browser without closing it (a scenario that timed out may have already left
 * its browser process killed or wedged; see `run.ts`'s `runWithBudget`). The next `withBrowser`
 * call launches fresh. Relaunching is exactly the "second launch in this process" pattern the
 * module comment describes as risky, so this is a last resort after a real hang, not something to
 * reach for otherwise.
 */
export function forgetAllBrowsers(): void {
  launched.clear();
}

/** Runs `body` with the process's shared browser for `name` (launched on first use). */
export async function withBrowser<T>(name: BrowserName, body: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await getBrowser(name);
  return body(browser);
}
