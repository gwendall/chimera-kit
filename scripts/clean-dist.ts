/**
 * Removes the JavaScript and declarations of the previous build from dist/, so that chunks with
 * old hashes are not published. The engine and the dictionary stay.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DIST = join(import.meta.dir, "../dist");
const names = await readdir(DIST).catch(() => [] as string[]);
for (const name of names) {
  if (name.endsWith(".js") || name.endsWith(".d.ts")) await rm(join(DIST, name));
}
