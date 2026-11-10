import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDist } from "../scripts/clean-dist.ts";

test("rebuilding removes retired provider declarations and old WASM names, preserving current assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chimera-kit-dist-"));
  try {
    await mkdir(join(directory, "engines"));
    for (const name of [
      "old-hash.js",
      "engines/kokoro.d.ts",
      "engines/web-speech-speaker.d.ts",
      "intone_chimera.wasm",
      "intone_creatures.wasm",
      "chimera.wasm",
      "creatures.wasm",
      "cmudict.txt.gz",
    ])
      await writeFile(join(directory, name), "fixture");
    await cleanDist(directory);
    expect((await readdir(directory)).sort()).toEqual([
      "chimera.wasm",
      "cmudict.txt.gz",
      "creatures.wasm",
      "engines",
    ]);
    expect(await readdir(join(directory, "engines"))).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
