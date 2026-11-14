import { expect, test } from "bun:test";
import { createPerformanceRenderer, type PhysicalPerformance } from "../dist/performance.js";

const performance: PhysicalPerformance = {
  version: 1,
  sampleRate: 48000,
  duration: 0.5,
  source: { pressure: 8, f0: 150, drift: 0 },
  gestures: [
    { t0: 0, t1: 0.4, rampIn: 0.01, rampOut: 0.03, strength: 5, targets: { breath: 1.2, jaw: 0.5, f0: 180 } },
  ],
};

test("prepared performance preserves state across borrowed chunks and samples telemetry on its clock", async () => {
  const outputs: Float32Array[] = [];
  for (const chunk of [127, 4096]) {
    const r = await createPerformanceRenderer(performance);
    try {
      const output = new Float32Array(r.samples);
      while (r.position < r.samples) {
        const start = r.position;
        const data = r.next(chunk);
        if (!data) throw new Error("ended before declared sample count");
        output.set(data, start);
      }
      expect(r.next()).toBeNull();
      expect(r.telemetry().clock).toBeCloseTo(0.5, 5);
      expect(output.every(Number.isFinite)).toBe(true);
      expect(output.some((x) => Math.abs(x) > 1e-4)).toBe(true);
      outputs.push(output);
    } finally {
      r.free();
      r.free();
    }
    expect(() => r.next()).toThrow("freed");
  }
  expect(outputs[0]).toEqual(outputs[1]);
});

test("prepared performance rejects incompatible clocks and invalid chunks", async () => {
  await expect(
    createPerformanceRenderer({ ...performance, version: 2 } as unknown as PhysicalPerformance),
  ).rejects.toThrow("version 1");
  const r = await createPerformanceRenderer(performance);
  try {
    expect(() => r.next(0)).toThrow("positive integer");
  } finally {
    r.free();
  }
});

test("checkpoints restore the exact acoustic history without copying or resetting the plan", async () => {
  const r = await createPerformanceRenderer(performance);
  try {
    r.next(4000);
    r.checkpoint();
    const expected = r.next(4000)?.slice();
    r.next(4000);
    expect(r.restore(4000)).toBe(4000);
    expect(r.next(4000)).toEqual(expected);
    expect(r.restore(1000)).toBe(0);
    r.next(1000);
    const first = r.next(1000)?.slice();
    expect(r.restore(1000)).toBe(0);
    r.next(1000);
    expect(r.next(1000)).toEqual(first);
  } finally {
    r.free();
  }
});

test("physical data rejects controls that JSON or native target parsing would silently discard", async () => {
  await expect(createPerformanceRenderer({ ...performance, source: { f0: NaN } })).rejects.toThrow("finite");
  await expect(
    createPerformanceRenderer({ ...performance, source: { typo: 1 } } as unknown as PhysicalPerformance),
  ).rejects.toThrow("unknown physical source");
  await expect(
    createPerformanceRenderer({
      ...performance,
      gestures: [{ ...performance.gestures[0], targets: { typo: 1 } }],
    } as unknown as PhysicalPerformance),
  ).rejects.toThrow("unknown physical target");
});

test("timed source controls preserve continuous physical state across seek", async () => {
  const r = await createPerformanceRenderer({
    ...performance,
    sourceEvents: [{ at: 0.08, source: { pressure: 5.5, tension: 0.8 } }],
  });
  try {
    r.next(3000);
    r.checkpoint();
    const expected = r.next(4000)?.slice();
    r.next(4000);
    expect(r.restore(3000)).toBe(3000);
    expect(r.next(4000)).toEqual(expected);
  } finally {
    r.free();
  }
});
