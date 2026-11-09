/** Runs a command, capturing stdout/stderr, with a bounded wall-clock budget (no outside alarm). */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<ExecResult> {
  const started = performance.now();
  const proc = Bun.spawn(cmd, {
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = opts.timeoutMs ?? 180_000;
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout, stderr, ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export async function dirSizeBytes(dir: string): Promise<number> {
  const r = await run(["du", "-sk", dir]);
  const kb = Number.parseInt(r.stdout.trim().split(/\s+/)[0] ?? "0", 10);
  return Number.isFinite(kb) ? kb * 1024 : -1;
}

export async function countTopLevelDeps(nodeModulesDir: string): Promise<number> {
  try {
    const entries = await Array.fromAsync(new Bun.Glob("*").scan({ cwd: nodeModulesDir, onlyFiles: false }));
    let count = 0;
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      if (e.startsWith("@")) {
        const scoped = await Array.fromAsync(
          new Bun.Glob("*").scan({ cwd: `${nodeModulesDir}/${e}`, onlyFiles: false }),
        );
        count += scoped.length;
      } else count++;
    }
    return count;
  } catch {
    return -1;
  }
}
