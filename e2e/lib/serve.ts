/**
 * Serves a directory to a page through request interception, exactly as `scripts/browser-check.ts`
 * does: no port, no process to leave running, nothing for the machine rules to worry about.
 */
import { join } from "node:path";
import type { Page } from "playwright-core";

const TYPES: Record<string, string> = {
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  html: "text/html",
  wasm: "application/wasm",
  gz: "application/gzip",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

export interface ServeOptions {
  /** index.html's body when the request is for "/". Defaults to a blank page with a <title>. */
  index?: string;
  /** Extra response headers, e.g. a strict CSP. Applied to every response. */
  headers?: Record<string, string>;
  /** Paths (relative to dir, no leading slash) that should 404 instead of being served. */
  missing?: string[];
  /** Paths that should come back with the wrong MIME type, to provoke a strict browser. */
  wrongMime?: Record<string, string>;
}

/** Routes every request to `${origin}/**` to files under `dir`. Returns nothing; call once per page. */
export async function serveDir(
  page: Page,
  origin: string,
  dir: string,
  options: ServeOptions = {},
): Promise<void> {
  const { index, headers = {}, missing = [], wrongMime = {} } = options;
  await page.route(`${origin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (path === "") {
      return route.fulfill({
        contentType: "text/html",
        headers,
        body: index ?? "<!doctype html><title>e2e</title>",
      });
    }
    if (missing.includes(path)) return route.fulfill({ status: 404, headers, body: "not found" });
    const file = Bun.file(join(dir, path));
    if (!(await file.exists())) return route.fulfill({ status: 404, headers, body: "" });
    const contentType = wrongMime[path] ?? TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";
    return route.fulfill({ contentType, headers, body: Buffer.from(await file.arrayBuffer()) });
  });
}
