/** Chrome spacing and public navigation: run against a machine serve URL or production. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { RELEASE } from "../site/lib/links";

setTimeout(() => process.exit(1), 60_000).unref();
const url = process.argv[2];
if (!url) throw new Error("Usage: bun scripts/site-layout-check.ts <url>");
const origin = new URL(url).origin;
const browser = await chromium.launch(
  process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {},
);
try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const ids = new Map<string, string[]>();
  const links: { path: string; href: string }[] = [];
  for (const path of ["/", "/docs"]) {
    for (const width of [390, 1440]) {
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        const response = await page.goto(`${origin}${path}`, { waitUntil: "load" });
        assert.equal(response?.status(), 200, `${path} did not load`);
        await page.locator("h1").waitFor();
        const layout = await page.locator("footer").evaluate((footer) => {
          const css = getComputedStyle(footer);
          const text = footer.querySelector("p");
          if (!text) throw new Error("Footer attribution is missing");
          return {
            top: parseFloat(css.paddingTop),
            bottom: parseFloat(css.paddingBottom),
            left: text.getBoundingClientRect().left,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        assert.ok(layout.top >= 24, `footer top padding collapsed: ${layout.top}px`);
        assert.ok(layout.bottom >= 40, `footer bottom padding collapsed: ${layout.bottom}px`);
        assert.ok(layout.left >= 16, "footer lost its page gutter");
        assert.equal(layout.overflow, false, `${path} ${width} ${colorScheme} overflow`);
        if (process.env.LAYOUT_SHOTS && width === 390 && colorScheme === "light") {
          const prefix = `${process.env.LAYOUT_SHOTS}-${path === "/" ? "home" : "docs"}`;
          await page.screenshot({ path: `${prefix}.png` });
          await page.locator("footer").screenshot({ path: `${prefix}-footer.png` });
        }
      }
    }
    ids.set(path, await page.locator("[id]").evaluateAll((nodes) => nodes.map((node) => node.id)));
    links.push(
      ...(await page
        .locator("a[href]")
        .evaluateAll(
          (nodes, path) => nodes.map((node) => ({ path, href: node.getAttribute("href") ?? "" })),
          path,
        )),
    );
  }
  for (const { path, href } of links) {
    const target = new URL(href, `${origin}${path}`);
    if (target.origin !== origin) continue;
    assert.ok(ids.has(target.pathname), `Unknown internal route: ${href}`);
    if (target.hash)
      assert.ok(ids.get(target.pathname)?.includes(target.hash.slice(1)), `Missing anchor: ${href}`);
  }
  await page.getByRole("button", { name: "Copy code", exact: true }).first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "npm install intone");
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal((await page.locator('a[href*="npmjs.com"]').count()) > 0, RELEASE.npmVersion !== null);
  assert.deepEqual(errors, []);
  console.log(`PASS: 8 layouts, ${links.length} links, clipboard and browser errors`);
} finally {
  await browser.close();
}
