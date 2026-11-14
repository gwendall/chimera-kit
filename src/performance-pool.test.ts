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
