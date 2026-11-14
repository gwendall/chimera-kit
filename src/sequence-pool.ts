/** Explicit phrase ownership over persistent native takes, on one output sample clock. */
import type { EnsembleMixPart } from "./ensemble-player.js";
import type { LiveTelemetry, PhysicalPerformance } from "./performance.js";
import {
  createPerformancePool,
  type PerformanceBlock,
  type PerformanceFrame,
  type PerformancePool,
  type PerformancePoolOptions,
  type PreparedCheckpoint,
} from "./performance-pool.js";

export interface PhysicalClip {
  performance: PhysicalPerformance;
  startSample: number;
  endSample: number;
  sourceSample: number;
  /** A whole native take retains physical state internally; ownership never sums its contexts. */
  intent: "phrase" | "continuous";
  shortEvent?: { evidence: string };
  gains?: number[];
  checkpoints?: PreparedCheckpoint[];
}
export interface SequencePart extends EnsembleMixPart {
  duration: number;
  clips: PhysicalClip[];
  /** Prepared physical pose for silent gaps. Avoids allocating the first native take just for a pose. */
  initialState?: LiveTelemetry;
}
interface Actor {
  part: SequencePart;
  position: number;
  idle: LiveTelemetry;
  active: { id: string; position: number } | null;
}
const clipId = (id: string, index: number) => JSON.stringify([id, index]);

function validate(parts: SequencePart[]): void {
  if (!parts.length || new Set(parts.map((p) => p.id)).size !== parts.length)
    throw new Error("sequence: unique nonempty parts required");
  for (const p of parts) {
    if (!p.id || !Number.isFinite(p.duration) || p.duration <= 0 || !p.clips.length)
      throw new Error("sequence: duration and physical takes required");
    let through = 0;
    if (p.initialState) {
      for (const [key, value] of Object.entries(p.initialState)) {
        if (
          typeof value === "number"
            ? !Number.isFinite(value)
            : !(value instanceof Float32Array) || !value.every(Number.isFinite)
        )
          throw new Error(`sequence: invalid prepared initial state ${key}`);
      }
      if (
        !p.initialState.artic.length ||
        !p.initialState.pharynxAreas.length ||
        !p.initialState.mouthAreas.length
      )
        throw new Error("sequence: incomplete prepared initial state");
    }
    for (const c of p.clips) {
      if (
        ![c.startSample, c.endSample, c.sourceSample].every(Number.isInteger) ||
        c.startSample < through ||
        c.endSample <= c.startSample ||
        c.endSample > Math.round(p.duration * 48000) ||
        c.sourceSample < 0 ||
        c.sourceSample + c.endSample - c.startSample > Math.round(c.performance.duration * 48000)
      )
        throw new Error("sequence: invalid or overlapping ownership");
      if (c.intent !== "phrase" && c.intent !== "continuous")
        throw new Error("sequence: explicit native take intent required");
      if (c.endSample - c.startSample < 9600 && !c.shortEvent?.evidence.trim())
        throw new Error("sequence: short owned sounds require explicit evidence");
      let product = 1;
      if ((c.gains?.length ?? 0) > 16) throw new Error("sequence: too many gain stages");
      for (const gain of c.gains ?? []) {
        product *= gain;
        if (!Number.isFinite(gain) || gain < 0 || gain > 32 || !Number.isFinite(product) || product > 32)
          throw new Error("sequence: gain stages must stay within0..32");
      }
      through = c.endSample;
    }
  }
}

function frame(clip: PhysicalClip, source: PerformanceFrame): PerformanceFrame {
  const sample = clip.startSample + source.sample - clip.sourceSample;
  let rms = source.state.outputRms;
  for (const gain of clip.gains ?? []) rms = Math.fround(rms * gain);
  return {
    sample,
    state: {
      ...source.state,
      outputRms: rms,
      clock: source.state.clock + (clip.startSample - clip.sourceSample) / 48000,
    },
  };
}

export async function createSequencePool(
  parts: SequencePart[],
  options: PerformancePoolOptions = {},
): Promise<PerformancePool> {
  validate(parts);
  const pool = await createPerformancePool(
    parts.flatMap((p) =>
      p.clips.map((c, i) => ({
        id: clipId(p.id, i),
        workerGroup: p.id,
        performance: c.performance,
        ...(c.checkpoints ? { checkpoints: c.checkpoints } : {}),
      })),
    ),
    options,
  );
  const actors = new Map<string, Actor>(),
    busy = new Set<string>();
  let freed = false;
  const free = () => {
    if (freed) return;
    freed = true;
    pool.free();
  };
  try {
    await Promise.all(
      parts.map(async (part) => {
        let state = part.initialState;
        if (!state) {
          const first = clipId(part.id, 0);
          state = (await pool.seek(first, 0)).state;
          await pool.release(first);
        }
        actors.set(part.id, {
          part,
          position: 0,
          active: null,
          idle: {
            ...state,
            f0: 0,
            voicing: 0,
            lungPressure: 0,
            outputRms: 0,
            noiseLevel: 0,
            gate: 0,
            clock: 0,
          },
        });
      }),
    );
  } catch (error) {
    free();
    throw error;
  }
  const actor = (id: string) => {
    if (freed) throw new Error("sequence: closed");
    const a = actors.get(id);
    if (!a) throw new Error(`sequence: unknown part ${id}`);
    if (busy.has(id)) throw new Error(`sequence: request already pending for ${id}`);
    return a;
  };
  const idle = (a: Actor, sample: number): PerformanceFrame => ({
    sample,
    state: { ...a.idle, clock: sample / 48000 },
  });
  const release = async (a: Actor) => {
    if (a.active) {
      await pool.release(a.active.id);
      a.active = null;
    }
  };
  const locate = (a: Actor, sample: number) =>
    a.part.clips.findIndex((c) => sample >= c.startSample && sample < c.endSample);
  const activate = async (
    a: Actor,
    index: number,
    sample: number,
    progress?: (sample: number) => void,
  ): Promise<PerformanceFrame | undefined> => {
    const c = a.part.clips[index];
    if (!c) throw new Error("sequence: missing native take");
    const id = clipId(a.part.id, index),
      target = c.sourceSample + sample - c.startSample;
    if (a.active?.id === id && a.active.position === target) return undefined;
    if (a.active?.id !== id) await release(a);
    const state = await pool.seek(
      id,
      target,
      progress ? (s) => progress(Math.max(0, c.startSample + s - c.sourceSample)) : undefined,
    );
    a.active = { id, position: target };
    return frame(c, state);
  };
  return {
    workers: pool.workers,
    async read(id, samples = 4800) {
      const a = actor(id);
      if (!Number.isInteger(samples) || samples < 1 || samples > 4800)
        throw new Error("sequence: read samples must be1..4800");
      busy.add(id);
      try {
        const start = a.position,
          end = Math.min(Math.round(a.part.duration * 48000), start + samples);
        const result: PerformanceBlock = { start, end, audio: new Float32Array(end - start), frames: [] };
        while (a.position < end) {
          const index = locate(a, a.position),
            c = a.part.clips[index];
          if (!c) {
            await release(a);
            result.frames.push(idle(a, a.position));
            const next = a.part.clips.find((c) => c.startSample > a.position)?.startSample ?? end;
            a.position = Math.min(end, next);
            continue;
          }
          const began = await activate(a, index, a.position);
          if (began) result.frames.push(began);
          const count = Math.min(end - a.position, c.endSample - a.position),
            active = a.active;
          if (!active) throw new Error("sequence: no active native take");
          const block = await pool.read(active.id, count);
          if (block.audio.length !== count) throw new Error("sequence: native take too short for ownership");
          const at = a.position - start;
          for (let i = 0; i < count; i++) {
            let value = block.audio[i] ?? 0;
            for (const gain of c.gains ?? []) value = Math.fround(value * gain);
            result.audio[at + i] = value;
          }
          for (const f of block.frames) {
            const mapped = frame(c, f);
            if (mapped.sample >= a.position && mapped.sample <= a.position + count)
              result.frames.push(mapped);
          }
          a.position += count;
          active.position = block.end;
        }
        return result;
      } finally {
        busy.delete(id);
      }
    },
    async seek(id, sample, progress) {
      const a = actor(id);
      if (!Number.isInteger(sample) || sample < 0 || sample > Math.round(a.part.duration * 48000))
        throw new Error("sequence: seek sample out of range");
      busy.add(id);
      try {
        const index = locate(a, sample);
        a.position = sample;
        if (index < 0) {
          await release(a);
          return idle(a, sample);
        }
        const state = await activate(a, index, sample, progress);
        if (state) return state;
        const c = a.part.clips[index];
        if (!c || !a.active) throw new Error("sequence: no active native take");
        return frame(c, await pool.seek(a.active.id, a.active.position));
      } finally {
        busy.delete(id);
      }
    },
    async release(id) {
      const a = actor(id);
      busy.add(id);
      try {
        await release(a);
        a.position = 0;
      } finally {
        busy.delete(id);
      }
    },
    free,
  };
}
