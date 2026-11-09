// The site runs on the library built from this repository. `lib/intone` is a copy of `dist`, not a
// dependency, so the bundler never has to reach outside the site's own folder.
import { cpSync, existsSync, rmSync } from "node:fs";

const dist = new URL("../../dist/", import.meta.url).pathname;
const into = new URL("../lib/intone/", import.meta.url).pathname;

if (!existsSync(`${dist}index.js`)) {
  console.error("site: no dist/index.js. Run `bun run build` at the repository's root first.");
  process.exit(1);
}
rmSync(into, { recursive: true, force: true });
cpSync(dist, into, { recursive: true });
console.log("site: library synced from dist/");
