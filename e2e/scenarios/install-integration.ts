/**
 * Install and integration, as a stranger would do it: `npm pack` the real tarball, install it with
 * npm, pnpm and bun in fresh temp projects, and build a minimal app with each of Next.js (App
 * Router), Vite and a plain bun bundle, with no configuration beyond what the README shows.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withBrowser } from "../lib/browsers.ts";
import { countTopLevelDeps, dirSizeBytes, run } from "../lib/exec.ts";
import { serveDir } from "../lib/serve.ts";
import type { Measurement, Scenario, ScenarioContext } from "../lib/types.ts";
import { THRESHOLDS } from "../thresholds.ts";

async function packTarball(ctx: ScenarioContext): Promise<string> {
  const destDir = join(ctx.tmp, "pack");
  await mkdir(destDir, { recursive: true });
  const r = await run(["npm", "pack", "--pack-destination", destDir, "--json"], {
    cwd: ctx.root,
    timeoutMs: 60_000,
  });
  if (r.code !== 0) throw new Error(`npm pack failed: ${r.stderr.slice(-1000)}`);
  const [info] = JSON.parse(r.stdout) as Array<{ filename: string }>;
  if (!info) throw new Error("npm pack produced no tarball");
  return join(destDir, info.filename);
}

/** Pulls every fenced \`\`\`ts block out of README.md, for a strict typecheck of what it tells people to write. */
async function readmeSnippets(root: string): Promise<string[]> {
  const text = await readFile(join(root, "README.md"), "utf8");
  const blocks: string[] = [];
  const re = /```ts\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks;
}

/**
 * Typechecks every snippet as its own module. A snippet is prose-adjacent and sometimes names a
 * variable the prose, not the fence, introduced (`answer`, a language model's text) or has no
 * `import` line at all (it continues an earlier snippet's example). Two passes: the first finds
 * every "Cannot find name" tsc reports *in that snippet* and declares just those names `any` in
 * that snippet's own preamble, the second is the real check, so a genuine API misuse still fails
 * it. (A single preamble applied to every snippet broke snippets that *do* declare a name
 * themselves - e.g. one with its own `const voice = ...` got a conflicting `declare const
 * voice: any` from a sibling snippet's missing name - so this must stay per snippet, not global.)
 */
async function typecheckReadmeSnippets(
  tcDir: string,
  snippets: string[],
): Promise<{ ok: boolean; note: string }> {
  await writeFile(
    join(tcDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        // A snippet without its own import/export (continuing an earlier one) is otherwise a
        // global *script*, not a module, so its top-level consts collide with every other
        // import-less snippet's same-named consts ("Cannot redeclare block-scoped variable
        // 'answer'" between two unrelated snippets that both use that prose placeholder name).
        // Each snippet file gets its own trailing `export {};` (below) to force module scope
        // instead; noImplicitAny is off because the names this scenario *does* fill in above are
        // deliberately untyped placeholders (`any`), and a callback parameter whose type would
        // normally flow from one of those (e.g. `voice.stream(text, { airway(state) {...} })`)
        // loses that inference the same way a real but unimported variable would - not a real
        // README mistake. strictNullChecks and the rest still catch a genuine API misuse.
        noImplicitAny: false,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        noEmit: true,
        lib: ["ES2022", "DOM"],
        // Without this, tsc auto-includes every @types/* package found by walking up from tcDir
        // - which is nested inside e2e/tmp, inside this repo - and picks up this repo's own
        // bun-types devDependency alongside the @types/node this scenario installs, two sets of
        // ambient globals (TLSSocket, KeyObject, ConnectionOptions, ...) redeclaring each other.
        // A real stranger's project is never nested inside this repo, so this is a harness
        // artifact of where e2e/lib puts its scratch directory, not a real README/types problem.
        types: ["node"],
      },
    }),
  );
  const names = snippets.map((_, i) => join(tcDir, `snippet-${i}.ts`));
  for (let i = 0; i < snippets.length; i++)
    await writeFile(names[i] as string, `${snippets[i] ?? ""}\nexport {};\n`);
  const tsc1 = await run(["bun", "x", "tsc", "-p", "tsconfig.json"], { cwd: tcDir, timeoutMs: 60_000 });
  const missingByFile = new Map<string, Set<string>>();
  for (const m of tsc1.stdout.matchAll(/^(snippet-\d+\.ts)\(.*error TS2304: Cannot find name '([^']+)'/gm)) {
    const file = m[1] as string;
    const name = m[2] as string;
    (missingByFile.get(file) ?? missingByFile.set(file, new Set()).get(file))?.add(name);
  }
  let tsc = tsc1;
  if (missingByFile.size > 0) {
    for (let i = 0; i < snippets.length; i++) {
      const missing = missingByFile.get(`snippet-${i}.ts`);
      if (!missing || missing.size === 0) continue;
      const preamble = [...missing].map((n) => `declare const ${n}: any;`).join("\n");
      await writeFile(names[i] as string, `${preamble}\n${snippets[i] ?? ""}\nexport {};\n`);
    }
    tsc = await run(["bun", "x", "tsc", "-p", "tsconfig.json"], { cwd: tcDir, timeoutMs: 60_000 });
  }
  return {
    ok: tsc.code === 0,
    note: tsc.code === 0 ? `${snippets.length} fenced ts blocks, strict` : tsc.stdout.slice(-2500),
  };
}

interface InstallResult {
  installMs: number;
  installBytes: number;
  depCount: number;
  ran: boolean;
  error?: string | undefined;
}

async function installWith(
  pm: "npm" | "pnpm" | "bun",
  tarball: string,
  ctx: ScenarioContext,
): Promise<InstallResult> {
  const dir = await mkdtemp(join(ctx.tmp, `install-${pm}-`));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "stranger-app", version: "0.0.0", private: true }),
  );
  const install =
    pm === "npm"
      ? await run(["npm", "install", tarball, "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 180_000 })
      : pm === "pnpm"
        ? // dir is under e2e/tmp, inside this repo, whose own package.json declares
          // `packageManager: bun@1.3.11`. Corepack's pnpm shim walks up from cwd looking for the
          // nearest package.json with a packageManager field and finds that one before it finds
          // this temp project's own (fieldless) one, then refuses: "Unsupported package manager
          // specification (bun@1.3.11)" - bun isn't a corepack-managed manager. A real stranger
          // installing intone is never nested inside this repo, so this is purely an artifact of
          // the harness's own scratch directory location, not a real pnpm/intone incompatibility.
          // COREPACK_ENABLE_PROJECT_SPEC=0 makes corepack ignore any ancestor packageManager field.
          await run(["pnpm", "add", tarball], {
            cwd: dir,
            timeoutMs: 180_000,
            env: { COREPACK_ENABLE_PROJECT_SPEC: "0" },
          })
        : await run(["bun", "add", tarball], { cwd: dir, timeoutMs: 180_000 });
  if (install.code !== 0)
    return {
      installMs: install.ms,
      installBytes: -1,
      depCount: -1,
      ran: false,
      error: install.stderr.slice(-1500),
    };
  const nodeModules = join(dir, "node_modules");
  const [installBytes, depCount] = await Promise.all([
    dirSizeBytes(nodeModules),
    countTopLevelDeps(nodeModules),
  ]);
  await writeFile(
    join(dir, "check.mjs"),
    `import { createVoice } from "intone";\nconst voice = await createVoice({ body: "female", dictionary: false });\nconst { audio } = voice.render("Hello there.");\nvoice.free();\nif (!(audio.length > 0)) throw new Error("no audio");\nconsole.log("ok", audio.length);\n`,
  );
  // Run with plain node regardless of installer: the point is that node's own resolution finds
  // what npm/pnpm/bun each installed, which is what most consumers (bundlers included) rely on.
  const ranCheck = await run(["node", "check.mjs"], { cwd: dir, timeoutMs: 30_000 });
  return {
    installMs: install.ms,
    installBytes,
    depCount,
    ran: ranCheck.code === 0 && ranCheck.stdout.includes("ok"),
    error: ranCheck.code === 0 ? undefined : ranCheck.stderr.slice(-1500) || ranCheck.stdout.slice(-500),
  };
}

async function buildNextApp(
  tarball: string,
  ctx: ScenarioContext,
): Promise<{ ok: boolean; ms: number; error?: string | undefined }> {
  const dir = await mkdtemp(join(ctx.tmp, "next-"));
  await mkdir(join(dir, "app"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "next-stranger",
      version: "0.0.0",
      private: true,
      scripts: { build: "next build" },
    }),
  );
  await writeFile(join(dir, "next.config.mjs"), "export default { output: 'export' };\n");
  await writeFile(
    join(dir, "app/layout.tsx"),
    `export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n`,
  );
  // A "use client" component that imports createVoice: the README's own usage, nothing more. Next
  // still imports this module on the server to render the initial HTML/RSC payload, so a crash at
  // import time (not inside the click handler) would fail the build.
  await writeFile(
    join(dir, "app/page.tsx"),
    `"use client";\nimport { createVoice } from "intone";\nexport default function Page() {\n  const onClick = async () => {\n    const voice = await createVoice({ body: "female" });\n    await voice.render("The birch canoe slid on the smooth planks.");\n    voice.free();\n  };\n  return <button onClick={onClick}>speak</button>;\n}\n`,
  );
  const install = await run(["bun", "add", tarball, "next@^16", "react@^19", "react-dom@^19"], {
    cwd: dir,
    timeoutMs: 240_000,
  });
  if (install.code !== 0)
    return { ok: false, ms: install.ms, error: `install: ${install.stderr.slice(-1500)}` };
  const build = await run(["bun", "x", "next", "build"], { cwd: dir, timeoutMs: 180_000 });
  return {
    ok: build.code === 0,
    ms: install.ms + build.ms,
    error: build.code === 0 ? undefined : build.stderr.slice(-2000),
  };
}

async function buildViteApp(
  tarball: string,
  ctx: ScenarioContext,
): Promise<{ ok: boolean; ms: number; error?: string | undefined; outDir?: string }> {
  const dir = await mkdtemp(join(ctx.tmp, "vite-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "index.html"),
    `<!doctype html><html><body><script type="module" src="/src/main.ts"></script></body></html>\n`,
  );
  await writeFile(
    join(dir, "src/main.ts"),
    `import { createVoice } from "intone";\n(async () => {\n  const voice = await createVoice({ body: "female" });\n  (globalThis as unknown as { __v: unknown }).__v = voice;\n})();\n`,
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "vite-stranger", version: "0.0.0", private: true }),
  );
  const install = await run(["bun", "add", tarball, "vite@^6"], { cwd: dir, timeoutMs: 240_000 });
  if (install.code !== 0)
    return { ok: false, ms: install.ms, error: `install: ${install.stderr.slice(-1500)}` };
  const build = await run(["bun", "x", "vite", "build"], { cwd: dir, timeoutMs: 120_000 });
  return {
    ok: build.code === 0,
    ms: install.ms + build.ms,
    error: build.code === 0 ? undefined : build.stderr.slice(-2000),
    outDir: join(dir, "dist"),
  };
}

async function buildBunBundle(
  tarball: string,
  ctx: ScenarioContext,
): Promise<{ ok: boolean; ms: number; error?: string | undefined; outDir?: string }> {
  const dir = await mkdtemp(join(ctx.tmp, "bunbundle-"));
  await writeFile(
    join(dir, "entry.ts"),
    `import { createVoice } from "intone";\n(async () => {\n  const voice = await createVoice({ body: "female" });\n  (globalThis as unknown as { __v: unknown }).__v = voice;\n})();\n`,
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "bun-bundle-stranger", version: "0.0.0", private: true }),
  );
  const install = await run(["bun", "add", tarball], { cwd: dir, timeoutMs: 180_000 });
  if (install.code !== 0)
    return { ok: false, ms: install.ms, error: `install: ${install.stderr.slice(-1500)}` };
  const started = performance.now();
  const outdir = join(dir, "out");
  const build = await run(["bun", "build", "entry.ts", "--outdir", outdir, "--target", "browser"], {
    cwd: dir,
    timeoutMs: 60_000,
  });
  return {
    ok: build.code === 0,
    ms: install.ms + (performance.now() - started),
    error: build.code === 0 ? undefined : build.stderr.slice(-2000),
    outDir: outdir,
  };
}

/** Confirms a bundler's output actually runs: loads it in a real page and calls createVoice(). */
async function confirmsInBrowser(
  outDir: string,
  entryFile: string,
): Promise<{ ok: boolean; error?: string | undefined }> {
  return withBrowser("chromium", async (browser) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const origin = "https://intone.stranger";
    await serveDir(page, origin, outDir, {
      index: `<!doctype html><script type="module" src="/${entryFile}"></script>`,
    });
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await page.waitForTimeout(500);
    const ok = await page.evaluate(() => {
      const v = (globalThis as unknown as { __v?: { render(t: string): { audio: Float32Array } } }).__v;
      if (!v) return false;
      return v.render("hi").audio.length > 0;
    });
    await context.close();
    return { ok: ok && errors.length === 0, error: errors[0] };
  });
}

export const scenario: Scenario = {
  id: "install-integration",
  description:
    "npm pack, install with npm/pnpm/bun in fresh temp projects, build minimal Next.js/Vite/bun-bundle " +
    "apps with no extra configuration, strict-typecheck the README's own snippets.",
  smoke: false,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    ctx.log("install-integration: npm pack");
    const tarball = await packTarball(ctx);
    const tarballSize = (await Bun.file(tarball).stat()).size;
    out.push({
      name: "install.tarball.bytes",
      value: tarballSize,
      unit: "bytes",
      threshold: THRESHOLDS.install.tarballBytes,
      pass: tarballSize <= THRESHOLDS.install.tarballBytes,
    });

    for (const pm of ["npm", "pnpm", "bun"] as const) {
      ctx.log(`install-integration: install with ${pm}`);
      const r = await installWith(pm, tarball, ctx);
      out.push(
        {
          name: `install.${pm}.installMs`,
          value: r.installMs,
          unit: "ms",
          threshold: THRESHOLDS.install.installMs,
          pass: r.ran && r.installMs <= THRESHOLDS.install.installMs,
        },
        {
          name: `install.${pm}.installedBytes`,
          value: r.installBytes,
          unit: "bytes",
          threshold: THRESHOLDS.install.installedBytes,
          pass: r.installBytes >= 0 && r.installBytes <= THRESHOLDS.install.installedBytes,
        },
        {
          name: `install.${pm}.depCount`,
          value: r.depCount,
          unit: "packages",
          threshold: THRESHOLDS.install.depCount,
          pass: r.depCount >= 0 && r.depCount <= THRESHOLDS.install.depCount,
        },
        {
          name: `install.${pm}.importAndRender`,
          value: r.ran ? 1 : 0,
          unit: "bool",
          threshold: 1,
          pass: r.ran,
          note: r.error,
        },
      );
    }

    ctx.log("install-integration: Next.js App Router build (SSR import)");
    const next = await buildNextApp(tarball, ctx);
    out.push({
      name: "install.nextjs.buildOk",
      value: next.ok ? 1 : 0,
      unit: "bool",
      threshold: 1,
      pass: next.ok,
      note: next.error,
    });
    out.push({
      name: "install.nextjs.buildMs",
      value: next.ms,
      unit: "ms",
      threshold: THRESHOLDS.install.frameworkBuildMs,
      pass: next.ok && next.ms <= THRESHOLDS.install.frameworkBuildMs,
    });

    ctx.log("install-integration: Vite build + browser load");
    const vite = await buildViteApp(tarball, ctx);
    out.push({
      name: "install.vite.buildOk",
      value: vite.ok ? 1 : 0,
      unit: "bool",
      threshold: 1,
      pass: vite.ok,
      note: vite.error,
    });
    out.push({
      name: "install.vite.buildMs",
      value: vite.ms,
      unit: "ms",
      threshold: THRESHOLDS.install.frameworkBuildMs,
      pass: vite.ok && vite.ms <= THRESHOLDS.install.frameworkBuildMs,
    });
    if (vite.ok && vite.outDir) {
      const assets = await Array.fromAsync(new Bun.Glob("assets/*.js").scan({ cwd: vite.outDir }));
      const entry = assets[0] ? `assets/${assets[0].split("/").pop()}` : "assets/main.js";
      const confirmed = await confirmsInBrowser(vite.outDir, entry);
      out.push({
        name: "install.vite.runsInBrowser",
        value: confirmed.ok ? 1 : 0,
        unit: "bool",
        threshold: 1,
        pass: confirmed.ok,
        note: confirmed.error,
      });
    }

    ctx.log("install-integration: plain bun bundle + browser load");
    const bunBundle = await buildBunBundle(tarball, ctx);
    out.push({
      name: "install.bunBundle.buildOk",
      value: bunBundle.ok ? 1 : 0,
      unit: "bool",
      threshold: 1,
      pass: bunBundle.ok,
      note: bunBundle.error,
    });
    out.push({
      name: "install.bunBundle.buildMs",
      value: bunBundle.ms,
      unit: "ms",
      threshold: THRESHOLDS.install.bundleBuildMs,
      pass: bunBundle.ok && bunBundle.ms <= THRESHOLDS.install.bundleBuildMs,
    });
    if (bunBundle.ok && bunBundle.outDir) {
      const confirmed = await confirmsInBrowser(bunBundle.outDir, "entry.js");
      out.push({
        name: "install.bunBundle.runsInBrowser",
        value: confirmed.ok ? 1 : 0,
        unit: "bool",
        threshold: 1,
        pass: confirmed.ok,
        note: confirmed.error,
      });
    }

    ctx.log("install-integration: strict typecheck of README snippets");
    const snippets = await readmeSnippets(ctx.root);
    const tcDir = await mkdtemp(join(ctx.tmp, "readme-tsc-"));
    await writeFile(
      join(tcDir, "package.json"),
      JSON.stringify({ name: "readme-tsc", version: "0.0.0", private: true }),
    );
    const install = await run(["bun", "add", tarball, "typescript@^5", "@types/node@^22"], {
      cwd: tcDir,
      timeoutMs: 120_000,
    });
    const typecheck =
      install.code === 0
        ? await typecheckReadmeSnippets(tcDir, snippets)
        : { ok: false, note: `install: ${install.stderr.slice(-800)}` };
    out.push({
      name: "install.readmeSnippets.strictTypecheck",
      value: typecheck.ok ? 1 : 0,
      unit: "bool",
      threshold: 1,
      pass: typecheck.ok,
      note: typecheck.note,
    });

    return out;
  },
};
