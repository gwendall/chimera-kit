/**
 * The machine this runs on is shared (16 GB Mac, other agents run CPU-heavy evals). Real-time
 * numbers (RTF, polyphony's breaking N, cold-start) move with load, so every report records
 * `uptime` and a short CPU calibration next to them.
 */

export interface Calibration {
  uptimeLine: string;
  /** Milliseconds for a fixed single-threaded busy-work unit: the yardstick for "load-sensitive". */
  busyWorkMs: number;
}

function busyWork(): number {
  // A fixed amount of floating point work, nothing the JIT can fold away.
  let x = 1.000001;
  for (let i = 0; i < 20_000_000; i++) x = Math.sin(x) * Math.cos(x) + x * 1.0000001;
  return x;
}

export async function calibrate(): Promise<Calibration> {
  const uptime = Bun.spawn(["uptime"], { stdout: "pipe" });
  const uptimeLine = (await new Response(uptime.stdout).text()).trim();
  await uptime.exited;
  const started = performance.now();
  busyWork();
  const busyWorkMs = performance.now() - started;
  return { uptimeLine, busyWorkMs };
}
