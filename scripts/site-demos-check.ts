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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await start.click();
  await sing.locator('.song-note[data-active="true"]').waitFor();
  assert.equal(await sing.locator(".song-head").isVisible(), false);
  await stop.click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log("PASS: mobile, dark theme and reduced motion; no browser errors or overflow");
} finally {
  await browser.close();
}
