import { expect, test } from "bun:test";
import { createPerformanceRenderer, type PhysicalPerformance } from "../dist/performance.js";
import { createSequencePool, type SequencePart } from "./sequence-pool.js";

const options = {
  wasm: new URL("../dist/chimera.wasm", import.meta.url),
  worker: new URL("../dist/performance-worker.js", import.meta.url),
};
const performance: PhysicalPerformance = {
  version: 1,
  sampleRate: 48000,
  duration: 0.4,
  source: { f0: 170, drift: 2 },
  gestures: [
    {
      t0: 0,
      t1: 0.35,
      rampIn: 0.01,
      rampOut: 0.03,
      strength: 5,
      targets: { breath: 1.1, f0: 200, jaw: 0.6, tbX: 2.5, tbY: 6.8 },
    },
  ],
};
const part: SequencePart = {
  id: "lead",
  duration: 0.5,
  clips: [
    {
      performance,
      startSample: 4800,
      endSample: 14400,
      sourceSample: 3840,
      intent: "phrase",
      gains: [0.3, 0.7],
    },
  ],
};

test("phrase ownership preserves native warmup, sample placement, gaps and gain rounding", async () => {
  const r = await createPerformanceRenderer(performance),
    raw = new Float32Array(r.samples);
  try {
    while (r.position < r.samples) {
      const at = r.position,
        block = r.next();
      if (!block) throw new Error("short reference");
      raw.set(block, at);
    }
  } finally {
    r.free();
  }
  const scaled = (from: number, to: number) =>
    raw.slice(from, to).map((x) => Math.fround(Math.fround(x * 0.3) * 0.7));
  const pool = await createSequencePool([part], options);
  try {
    const rest = await pool.read("lead");
    expect(rest.audio.every((x) => x === 0)).toBe(true);
    expect(rest.frames[0]?.state.gate).toBe(0);
    const first = await pool.read("lead");
    expect(first.start).toBe(4800);
    expect(first.audio).toEqual(scaled(3840, 8640));
    expect(first.frames[0]?.sample).toBe(4800);
    expect(first.frames.every((f) => f.sample >= 4800 && f.sample <= 9600)).toBe(true);
    expect((await pool.read("lead")).audio).toEqual(scaled(8640, 13440));
    expect((await pool.read("lead")).audio.every((x) => x === 0)).toBe(true);
    const sought = await pool.seek("lead", 6000);
    expect(sought.sample).toBe(6000);
    expect((await pool.read("lead", 3000)).audio).toEqual(scaled(5040, 8040));
    const silent = await pool.seek("lead", 20000);
    expect(silent.state.outputRms).toBe(0);
    await pool.release("lead");
    expect((await pool.read("lead")).start).toBe(0);
  } finally {
    pool.free();
  }
});

test("unreviewed tiny slices and overlapping voice ownership fail before native allocation", async () => {
  await expect(
    createSequencePool(
      [{ ...part, clips: [{ ...part.clips[0], endSample: 5000 }] }] as SequencePart[],
      options,
    ),
  ).rejects.toThrow("short owned sounds");
  const first = part.clips[0];
  if (!first) throw new Error("missing fixture");
  await expect(
    createSequencePool([{ ...part, clips: [first, { ...first, startSample: 5000 }] }], options),
  ).rejects.toThrow("overlapping");
  await expect(
    createSequencePool([{ ...part, clips: [{ ...first, sourceSample: 17000 }] }], options),
  ).rejects.toThrow("ownership");
});

test("prepared idle pose avoids throwaway native warmup while retaining exact owned audio", async () => {
  const renderer = await createPerformanceRenderer(performance);
  const initialState = renderer.telemetry();
  renderer.free();
  const a = await createSequencePool([part], options);
  const b = await createSequencePool([{ ...part, initialState }], options);
  try {
    for (let block = 0; block < 5; block++)
      expect((await b.read("lead")).audio).toEqual((await a.read("lead")).audio);
    expect((await b.seek("lead", 0)).state.gate).toBe(0);
  } finally {
    a.free();
    b.free();
  }
  await expect(
    createSequencePool([{ ...part, initialState: { ...initialState, f0: NaN } }], options),
  ).rejects.toThrow("invalid prepared initial state");
});
