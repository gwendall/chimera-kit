/** Regression checks for the site's audio controls. Run against a machine serve URL or production. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

setTimeout(() => process.exit(1), 60_000).unref();
const url = process.argv[2];
if (!url) throw new Error("Usage: bun scripts/site-demos-check.ts <url>");
console.log(`site demos: runner PID ${process.pid}`);
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(url, { waitUntil: "load" });
  const sing = page.locator("#sing");
  const start = sing.getByRole("button", { name: "Sing it", exact: true });
  const stop = sing.getByRole("button", { name: "Stop", exact: true });
  const moving = async () => {
    await sing.locator('.song-note[data-active="true"]').waitFor();
    const before = await sing.locator(".song-head").getAttribute("style");
    await page.waitForTimeout(350);
    assert.notEqual(await sing.locator(".song-head").getAttribute("style"), before);
  };

  await start.click();
  await moving();
  await stop.click();
  await start.waitFor();
  assert.equal(await sing.locator('.song-note[data-active="true"]').count(), 0);
  console.log("PASS: solo playback advances the melody; Stop clears the active note");

  await sing.getByRole("button", { name: "Third above", exact: true }).click();
  await sing.getByRole("button", { name: "Scoops and falls", exact: true }).click();
  await start.click();
  await stop.click();
  await page.waitForTimeout(500);
  assert.equal(await start.isVisible(), true, "a stopped preparation must not restart playback");
  await start.click();
  await moving();
  await start.waitFor({ timeout: 20_000 });
  assert.equal(await sing.locator('.song-note[data-active="true"]').count(), 0);
  console.log("PASS: harmony preparation can be cancelled; harmony tracks playback and resets on completion");

  const agents = page.locator("#agents");
  const calls = agents.locator("li");
  const tools = agents.getByRole("button", { name: "Run the tool calls", exact: true });
  await tools.click();
  await tools.waitFor({ timeout: 15_000 });
  assert.deepEqual(await calls.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-state"))), [
    "done",
    "done",
    "refused",
    "done",
  ]);
  assert.match((await calls.nth(2).textContent()) ?? "", /Needs correction/);
  assert.match((await calls.nth(3).textContent()) ?? "", /corrected melody was sung/);
  assert.equal(await agents.locator("details[open]").count(), 0, "raw JSON stays behind the disclosure");
  await calls.nth(2).locator("summary").click();
  assert.match((await calls.nth(2).locator("pre").textContent()) ?? "", /"ok": false/);
  await calls.nth(2).locator("summary").click();
  if (process.env.SITE_CHECK_SCREENSHOT) {
    await agents.locator(".panel").screenshot({ path: `${process.env.SITE_CHECK_SCREENSHOT}-desktop.png` });
  }
  await tools.click();
  await agents.getByRole("button", { name: "Interrupt", exact: true }).click();
  await tools.click();
  await tools.waitFor({ timeout: 15_000 });
  assert.equal(await calls.count(), 4);
  assert.equal(await calls.filter({ hasText: "The corrected melody was sung." }).count(), 1);
  console.log("PASS: four readable tool outcomes, explicit refusal, optional JSON, interrupt and rerun");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await start.click();
  await sing.locator('.song-note[data-active="true"]').waitFor();
  assert.equal(await sing.locator(".song-head").isVisible(), false);
  await stop.click();
  if (process.env.SITE_CHECK_SCREENSHOT) {
    await agents.locator(".panel").screenshot({ path: `${process.env.SITE_CHECK_SCREENSHOT}-mobile.png` });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS: mobile, dark theme and reduced motion; no browser errors or overflow");
} finally {
  await browser.close();
}
