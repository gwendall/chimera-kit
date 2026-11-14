import { expect, test } from "bun:test";
import { createPerformanceRenderer, type PhysicalPerformance } from "../dist/performance.js";

const input: PhysicalPerformance = {
  version: 1,
  sampleRate: 48000,
  duration: 1,
  source: { f0: 170, pressure: 8, drift: 2 },
  gestures: [
    {
      t0: 0,
      t1: 0.9,
      rampIn: 0.01,
      rampOut: 0.03,
      strength: 5,
      targets: { breath: 1.1, f0: 200, jaw: 0.7, tbX: 2.5, tbY: 6.8 },
    },
  ],
};

async function captured() {
  const r = await createPerformanceRenderer(input, { captureState: true });
  try {
    for (let i = 0; i < 8; i++) r.next(3000);
    const state = await r.exportState(),
      expected = r.next(4096)?.slice();
    return { state, expected };
  } finally {
    r.free();
  }
}

test("portable page deltas restore exact physical waves in a fresh wasm instance", async () => {
  const { state, expected } = await captured();
  const restored = await createPerformanceRenderer(input, { state });
  try {
    expect(restored.position).toBe(24000);
    expect(restored.next(4096)).toEqual(expected);
    expect(state.length).toBeLessThan(2 * 1024 * 1024);
    await expect(restored.exportState()).rejects.toThrow("captureState");
  } finally {
    restored.free();
  }
});

test("portable state rejects wrong inputs and invalid pages before changing memory", async () => {
  const { state } = await captured();
  await expect(
    createPerformanceRenderer({ ...input, source: { ...input.source, f0: 171 } }, { state }),
  ).rejects.toThrow("base mismatch");
  await expect(createPerformanceRenderer(input, { state: state.slice(0, -1) })).rejects.toThrow("bounds");
  const wrongEngine = state.slice();
  wrongEngine[40] = (wrongEngine[40] ?? 0) ^ 1;
  await expect(createPerformanceRenderer(input, { state: wrongEngine })).rejects.toThrow("engine mismatch");
  const corrupt = state.slice();
  corrupt[120] = (corrupt[120] ?? 0) ^ 1;
  await expect(createPerformanceRenderer(input, { state: corrupt })).rejects.toThrow("checksum");
  const badPage = state.slice();
  new DataView(badPage.buffer).setUint32(104, 1, true);
  await expect(createPerformanceRenderer(input, { state: badPage })).rejects.toThrow("page");
});
