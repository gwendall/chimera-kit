/** Footer regression: run against a machine serve URL or production. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

setTimeout(() => process.exit(1), 60_000).unref();
const url = process.argv[2];
if (!url) throw new Error("Usage: bun scripts/site-layout-check.ts <url>");
console.log(`layout check PID ${process.pid}`);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(url, { waitUntil: "load" });
  const footer = await page.locator("footer").evaluate((node) => {
    const css = getComputedStyle(node);
    return {
      top: parseFloat(css.paddingTop),
      bottom: parseFloat(css.paddingBottom),
      left: parseFloat(css.paddingLeft),
    };
  });
  console.log(JSON.stringify(footer));
  if (process.env.LAYOUT_SHOTS) {
    await page.locator("footer").screenshot({ path: `${process.env.LAYOUT_SHOTS}-footer.png` });
    await page.locator("#how .throat-screen").scrollIntoViewIfNeeded();
    await page.locator("#how canvas").waitFor();
    await page.waitForTimeout(600);
    await page.locator("#how .throat-screen").screenshot({ path: `${process.env.LAYOUT_SHOTS}-profile.png` });
  }
  assert.ok(footer.top >= 24, `footer top padding collapsed: ${footer.top}px`);
  assert.ok(footer.bottom >= 40, `footer bottom padding collapsed: ${footer.bottom}px`);
  assert.ok(footer.left >= 16, "footer lost its page gutter");
  console.log("PASS: footer keeps vertical room and the page gutter");
} finally {
  await browser.close();
}
