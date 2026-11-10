/**
 * Removes the JavaScript and declarations of the previous build from dist/, so that chunks with
 * old hashes are not published. Current engines and the dictionary stay.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DIST = join(import.meta.dir, "../dist");
const LEGACY = new Set(["intone_chimera.wasm", "intone_creatures.wasm"]);

export async function cleanDist(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await cleanDist(path);
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts") || LEGACY.has(entry.name)) {
      await rm(path);
    }
  }
}

if (import.meta.main) await cleanDist(DIST);
