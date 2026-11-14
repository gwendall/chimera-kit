import { expect, test } from "bun:test";
import { createPerformanceRenderer, type PhysicalPerformance } from "../dist/performance.js";
import { createPerformancePool } from "../dist/performance-pool.js";

const performance: PhysicalPerformance = {
  version: 1,
  sampleRate: 48000,
  duration: 0.2,
  source: { f0: 180 },
  gestures: [
    { t0: 0, t1: 0.15, rampIn: 0.01, rampOut: 0.03, strength: 5, targets: { breath: 1.1, f0: 200 } },
  ],
};

test("bounded workers preserve independent voice continuity and transfer sample-clock telemetry", async () => {
  const pool = await createPerformancePool(
    ["a", "b", "c"].map((id) => ({ id, performance })),
    { workers: 2 },
  );
  const reference = await createPerformanceRenderer(performance);
  try {
    expect(pool.workers).toBe(2);
    const blocks = await Promise.all(["a", "b", "c"].map((id) => pool.read(id)));
    const expected = new Float32Array(4800);
    const first = reference.next(4096);
    if (!first) throw new Error("missing reference");
    expected.set(first);
    const second = reference.next(704);
    if (!second) throw new Error("missing reference tail");
    expected.set(second, 4096);
    for (const block of blocks) {
      expect(block.audio).toEqual(expected);
      expect(block.start).toBe(0);
      expect(block.end).toBe(4800);
      expect(block.frames.map((f) => f.sample)).toEqual([0, 800, 1600, 2400, 3200, 4000, 4800]);
    }
    expect((await pool.read("a")).start).toBe(4800);
    expect((await pool.read("a")).audio.length).toBe(0);
    await expect(pool.read("unknown")).rejects.toThrow("unknown");
  } finally {
    reference.free();
    pool.free();
    pool.free();
  }
  await expect(pool.read("a")).rejects.toThrow("closed");
});

test("worker seek replays exact physical history and reports the requested sample", async () => {
  const pool = await createPerformancePool([{ id: "a", performance }], { workers: 1 });
  try {
    const original = await pool.read("a");
    await pool.read("a");
    expect((await pool.seek("a", 0)).sample).toBe(0);
    expect((await pool.read("a")).audio).toEqual(original.audio);
    expect((await pool.seek("a", 1600)).sample).toBe(1600);
    const block = await pool.read("a", 3200);
    expect(block.start).toBe(1600);
    expect(block.audio).toEqual(original.audio.slice(1600));
  } finally {
    pool.free();
  }
});

test("inactive phrases share performer workers and release physical instances without losing their data", async () => {
  const pool = await createPerformancePool(
    [
      { id: "first", workerGroup: "singer", performance },
      { id: "second", workerGroup: "singer", performance },
      { id: "bass", workerGroup: "bassist", performance },
    ],
    { workers: 8 },
  );
  try {
    expect(pool.workers).toBe(2);
    const first = await pool.read("first");
    await pool.release("first");
    expect((await pool.read("first")).audio).toEqual(first.audio);
    expect((await pool.read("second")).audio).toEqual(first.audio);
    await pool.release("first");
    await pool.release("first");
    await expect(pool.release("unknown")).rejects.toThrow("unknown");
  } finally {
    pool.free();
  }
});

test("unvisited seeks load an integrity-bound physical checkpoint and continue exactly", async () => {
  const r = await createPerformanceRenderer(performance, { captureState: true });
  let state: Uint8Array, expected: Float32Array;
  try {
    r.next(2400);
    state = await r.exportState();
    expected = new Float32Array(4800);
    const first = r.next(4096);
    if (!first) throw new Error("missing reference");
    expected.set(first);
    const tail = r.next(704);
    if (!tail) throw new Error("missing reference tail");
    expected.set(tail, 4096);
  } finally {
    r.free();
  }
  const hash = Bun.CryptoHasher.hash("sha256", state, "hex");
  const pool = await createPerformancePool([
    { id: "a", performance, checkpoints: [{ sample: 2400, source: Bun.gzipSync(state), sha256: hash }] },
  ]);
  try {
    expect((await pool.seek("a", 2400)).sample).toBe(2400);
    expect((await pool.read("a")).audio).toEqual(expected);
  } finally {
    pool.free();
  }
  const invalid = await createPerformancePool([
    { id: "a", performance, checkpoints: [{ sample: 2400, source: state, sha256: "0".repeat(64) }] },
  ]);
  try {
    await expect(invalid.seek("a", 2400)).rejects.toThrow("integrity");
  } finally {
    invalid.free();
  }
});
