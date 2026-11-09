import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// A bundler copies the file that `new URL("./worklet-live.js", import.meta.url)` names as a plain
// asset, without following its imports: a worklet that imported a shared chunk would then fail in
// `addModule` inside a Next or Vite app, while working when dist/ is served as it is.
test("the built worklet module imports nothing, so a bundler can copy it as it is", () => {
  const code = readFileSync(new URL("../dist/worklet-live.js", import.meta.url), "utf8");
  expect(code).not.toMatch(/(?:^|[;}\n])\s*import\s*[{*"']/);
  expect(code).not.toMatch(/\bimport\s*\(/);
  expect(code).toContain("registerProcessor");
});
