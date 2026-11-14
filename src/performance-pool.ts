/** A bounded pool of persistent physical voices. Rendering advances only when asked. */

import type { Source } from "./engines/chimera.js";
import { compilePerformance, type LiveTelemetry, type PhysicalPerformance } from "./performance.js";

export interface PerformanceFrame {
  sample: number;
  state: LiveTelemetry;
}
export interface PerformanceBlock {
  start: number;
  end: number;
  audio: Float32Array;
  frames: PerformanceFrame[];
}
export interface PerformancePart {
  id: string;
  performance: PhysicalPerformance;
  /** Keep mutually exclusive phrases of one performer on the same Worker. */
  workerGroup?: string;
}
export interface PerformancePool {
  readonly workers: number;
  /** Demand at most 4800 samples. Calls for a voice advance its one continuous renderer. */
  read(id: string, samples?: number): Promise<PerformanceBlock>;
  /** Exact seek, restoring prior acoustic checkpoints before forward synthesis. */
  seek(id: string, sample: number, progress?: (sample: number) => void): Promise<PerformanceFrame>;
  /** Release this native instance; a subsequent read starts its plan again at zero. */
  release(id: string): Promise<void>;
  free(): void;
}
export interface PerformancePoolOptions {
  wasm?: Source;
  workers?: number;
  worker?: URL | string;
}

interface Reply {
  request: number;
  result?: PerformanceBlock;
  error?: string;
  progress?: number;
}

export async function createPerformancePool(
  parts: PerformancePart[],
  options: PerformancePoolOptions = {},
): Promise<PerformancePool> {
  if (!parts.length || new Set(parts.map((p) => p.id)).size !== parts.length) {
    throw new Error("chimera-kit: performance part IDs must be nonempty and unique");
  }
  if (parts.some((p) => !p.id)) throw new Error("chimera-kit: empty performance part ID");
  const available = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 2);
  const groups = [...new Set(parts.map((p) => p.workerGroup ?? p.id))];
  const budget = options.workers ?? Math.min(8, available);
  if (!Number.isInteger(budget) || budget < 1 || budget > 16)
    throw new Error("chimera-kit: workers must be 1..16");
  const count = Math.min(groups.length, budget);
  const module = await compilePerformance(options.wasm);
  const workers: Worker[] = [];
  const pending = new Map<
    number,
    {
      resolve: (r: PerformanceBlock | undefined) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      progress?: (sample: number) => void;
    }
  >();
  const owners = new Map<string, Worker>();
  const reading = new Set<string>();
  let serial = 0,
    freed = false;
  const free = () => {
    if (freed) return;
    freed = true;
    for (const w of workers) w.terminate();
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("chimera-kit: performance pool closed"));
    }
    pending.clear();
  };
  const rpc = (
    worker: Worker,
    message: object,
    progress?: (sample: number) => void,
  ): Promise<PerformanceBlock | undefined> => {
    if (freed) return Promise.reject(new Error("chimera-kit: performance pool closed"));
    const request = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("chimera-kit: performance worker timed out"));
        free();
      }, 30000);
      pending.set(request, { resolve, reject, timer, ...(progress ? { progress } : {}) });
      try {
        worker.postMessage({ ...message, request });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(request);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  try {
    for (let i = 0; i < count; i++) {
      const w = new Worker(options.worker ?? new URL("./performance-worker.js", import.meta.url), {
        type: "module",
      });
      workers.push(w);
      w.onmessage = (event: MessageEvent<Reply>) => {
        const p = pending.get(event.data.request);
        if (!p) return;
        if (event.data.progress !== undefined) {
          clearTimeout(p.timer);
          p.timer = setTimeout(() => free(), 30000);
          p.progress?.(event.data.progress);
          return;
        }
        pending.delete(event.data.request);
        clearTimeout(p.timer);
        if (event.data.error) p.reject(new Error(event.data.error));
        else p.resolve(event.data.result);
      };
      w.onerror = () => free();
    }
    await Promise.all(
      workers.map((w, i) => {
        const assigned = parts.filter((p) => groups.indexOf(p.workerGroup ?? p.id) % count === i);
        for (const p of assigned) owners.set(p.id, w);
        return rpc(w, { type: "init", module, parts: assigned });
      }),
    );
  } catch (error) {
    free();
    throw error;
  }
  return {
    workers: count,
    async read(id, samples = 4800) {
      if (!Number.isInteger(samples) || samples < 1 || samples > 4800)
        throw new Error("chimera-kit: read samples must be 1..4800");
      const owner = owners.get(id);
      if (!owner) throw new Error(`chimera-kit: unknown performance part ${id}`);
      if (reading.has(id)) throw new Error(`chimera-kit: read already pending for ${id}`);
      reading.add(id);
      try {
        const result = await rpc(owner, { type: "read", id, samples });
        if (!result) throw new Error("chimera-kit: empty performance worker reply");
        return result;
      } finally {
        reading.delete(id);
      }
    },
    async seek(id, sample, progress) {
      const part = parts.find((p) => p.id === id),
        owner = owners.get(id);
      if (!part || !owner) throw new Error(`chimera-kit: unknown performance part ${id}`);
      if (!Number.isInteger(sample) || sample < 0 || sample > Math.round(part.performance.duration * 48000))
        throw new Error("chimera-kit: seek sample out of range");
      if (reading.has(id)) throw new Error(`chimera-kit: read already pending for ${id}`);
      reading.add(id);
      try {
        const result = await rpc(owner, { type: "seek", id, sample }, progress);
        const frame = result?.frames[0];
        if (!frame) throw new Error("chimera-kit: missing seek state");
        return frame;
      } finally {
        reading.delete(id);
      }
    },
    async release(id) {
      const owner = owners.get(id);
      if (!owner) throw new Error(`chimera-kit: unknown performance part ${id}`);
      if (reading.has(id)) throw new Error(`chimera-kit: read already pending for ${id}`);
      reading.add(id);
      try {
        await rpc(owner, { type: "release", id });
      } finally {
        reading.delete(id);
      }
    },
    free,
  };
}
