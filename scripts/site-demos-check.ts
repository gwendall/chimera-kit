/** Regression checks for the site's audio controls. Run against a machine serve URL or production. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

setTimeout(() => process.exit(1), 60_000).unref();
const url = process.argv[2];
if (!url) throw new Error("Usage: bun scripts/site-demos-check.ts <url>");
console.log(`site demos: runner PID ${process.pid}`);
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  if (process.argv.includes("--readiness")) {
    await page.route("**/*chimera*.wasm", (route) => route.abort());
    await page.goto(url, { waitUntil: "load" });
    const retry = page.getByRole("button", { name: "Retry loading Chimera", exact: true });
    await retry.waitFor();
    if (process.env.SITE_CHECK_SCREENSHOT)
      await page.screenshot({ path: `${process.env.SITE_CHECK_SCREENSHOT}-load-failed.png` });
    assert.match(
      (await page
        .getByRole("alert")
        .filter({ hasText: /connection/i })
        .first()
        .textContent()) ?? "",
      /connection/i,
    );
    await page.unroute("**/*chimera*.wasm");
    await retry.click();
    await page.getByRole("button", { name: "Speak", exact: true }).first().waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(".director button.go");
      return button !== null && !button.disabled;
    });
    assert.equal(await retry.count(), 0);
    console.log("PASS: failed main download is visible and retries without reloading");

    await page.route("**/*creatures*.wasm", (route) => route.abort());
    await page.locator("#creatures").scrollIntoViewIfNeeded();
    const creatureRetry = page.getByRole("button", { name: "Retry creature calls", exact: true });
    await creatureRetry.waitFor();
    await page.unroute("**/*creatures*.wasm");
    await creatureRetry.click();
    await page.locator("#creatures .beast").first().waitFor();
    assert.equal(await page.locator("#creatures .beast").count(), 4);
    console.log("PASS: failed creature download exposes a working retry");

    const triangle = page.locator('#voices button[aria-label^="Body blend"]');
    await triangle.focus();
    const blend = await triangle.getAttribute("aria-label");
    await page.keyboard.press("ArrowRight");
    assert.notEqual(await triangle.getAttribute("aria-label"), blend);
    const note = page.locator("#sing .song-note").first();
    await note.focus();
    const pitch = Number(await note.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowUp");
    assert.equal(Number(await note.getAttribute("aria-valuenow")), pitch + 1);
    await page.locator("#sing").getByRole("button", { name: "Stop", exact: true }).click();
    const pad = page.locator("#instrument .pad");
    await pad.focus();
    await page.keyboard.down("Space");
    await page.waitForFunction(
      () => document.querySelector("#instrument .pad")?.getAttribute("data-playing") === "true",
    );
    await page.getByText(/the engine reacts within/).waitFor();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Space");
    assert.equal(await pad.getAttribute("data-playing"), "false");
    await page.keyboard.down("Enter");
    await page.locator("#instrument").getByRole("button", { name: "i", exact: true }).focus();
    await page.keyboard.up("Enter");
    assert.equal(await pad.getAttribute("data-playing"), "false", "blur releases a held note");
    await pad.hover();
    await page.mouse.down();
    await pad.dispatchEvent("pointercancel");
    await page.mouse.up();
    assert.equal(await pad.getAttribute("data-playing"), "false", "pointer cancellation releases a note");
    if (process.env.SITE_CHECK_SCREENSHOT)
      await page.screenshot({ path: `${process.env.SITE_CHECK_SCREENSHOT}-keyboard-ready.png` });
    console.log("PASS: keyboard blend and melody edits; live notes release on keyup, blur and cancellation");
    assert.deepEqual(
      errors.filter((error) => !error.includes("net::ERR_FAILED")),
      [],
    );
  } else {
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
    console.log(
      "PASS: harmony preparation can be cancelled; harmony tracks playback and resets on completion",
    );

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
  }
} finally {
  await browser.close();
}
