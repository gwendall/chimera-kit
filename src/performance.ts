/** Compiled physical performances. No dictionary, replanning, gain correction or voice resets. */
import type { Body } from "./engine.js";
import type { Source } from "./engines/chimera.js";
import { compilePerformance, performanceEngineId } from "./engines/performance-module.js";
import { exportState, importState, type StateIdentity } from "./performance-state.js";

export { compilePerformance } from "./engines/performance-module.js";

import {
  type ArticValues,
  type LiveTelemetry,
  parseTelemetry,
  type SourceValues,
} from "./engines/chimera-live.js";
import { validatePhysical } from "./physical-validation.js";

export type { Body, LiveTelemetry, SourceValues };

export interface PhysicalGesture {
  t0: number;
  t1: number;
  rampIn: number;
  rampOut: number;
  strength: number;
  targets: ArticValues & {
    abduction?: number;
    closure?: number;
    breath?: number;
    f0?: number;
    vibrato?: number;
  };
  speed?: number;
  releaseHold?: number;
  label?: string;
  tag?: number;
}

/** Times are absolute seconds from this physical voice's origin, at the native 48 kHz clock. */
export interface PhysicalPerformance {
  version: 1;
  sampleRate: 48000;
  duration: number;
  body?: Body;
  source?: SourceValues;
  gestures: PhysicalGesture[];
  /** Sample-timed source changes, preserving one physical voice and its acoustic state. */
  sourceEvents?: { at: number; source: SourceValues }[];
}

export interface PerformanceRenderer {
  readonly sampleRate: 48000;
  readonly samples: number;
  readonly position: number;
  /** Borrowed wasm view, valid until the next call. At most 4096 samples. Null at the end. */
  next(max?: number): Float32Array | null;
  /** Physical state at position/sampleRate. Consumers must align it with heard audio. */
  telemetry(): LiveTelemetry;
  /** Save a bounded physical checkpoint between blocks, for subsequent seeking. */
  checkpoint(): void;
  /** Export a portable memory delta when captureState was enabled at creation. */
  exportState(): Promise<Uint8Array>;
  /** Restore at or before sample; render the remaining interval to seek exactly. */
  restore(sample: number): number;
  /** Idempotent. All other methods throw after freeing. */
  free(): void;
}

interface Exports {
  memory: WebAssembly.Memory;
  ic_abi_version(): number;
  ic_alloc(n: number): number;
  ic_free(p: number, n: number): void;
  ic_speaker_new(): number;
  ic_speaker_free(s: number): void;
  ic_speaker_error_ptr(s: number): number;
  ic_speaker_error_len(s: number): number;
  ic_performance_new(s: number, json: number, len: number): number;
  ic_performance_free(h: number): void;
  ic_performance_checkpoint(h: number): void;
  ic_performance_restore(h: number, sample: number): number;
  ic_performance_render(s: number, h: number, max: number): number;
  ic_performance_buffer(h: number): number;
  ic_performance_telemetry(h: number): number;
  ic_performance_telemetry_len(h: number): number;
}

export async function createPerformanceRenderer(
  performance: PhysicalPerformance,
  options: {
    wasm?: Source;
    module?: WebAssembly.Module;
    engineId?: string;
    captureState?: boolean;
    state?: Uint8Array;
  } = {},
): Promise<PerformanceRenderer> {
  validatePhysical(performance);
  const module = options.module ?? (await compilePerformance(options.wasm));
  const instance = await WebAssembly.instantiate(module, {});
  const x = instance.exports as unknown as Exports;
  if (x.ic_abi_version() !== 7)
    throw new Error(`chimera-kit: performance requires ABI 7, got ${x.ic_abi_version()}`);
  const bytes = new TextEncoder().encode(JSON.stringify(performance));
  const speaker = x.ic_speaker_new();
  const error = () =>
    new Error(
      `chimera-kit: ${new TextDecoder().decode(
        new Uint8Array(x.memory.buffer, x.ic_speaker_error_ptr(speaker), x.ic_speaker_error_len(speaker)),
      )}`,
    );
  const pointer = x.ic_alloc(bytes.length);
  let handle: number;
  try {
    new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
    handle = x.ic_performance_new(speaker, pointer, bytes.length);
    if (!handle) throw error();
  } catch (e) {
    x.ic_speaker_free(speaker);
    throw e;
  } finally {
    x.ic_free(pointer, bytes.length);
  }
  let base: Uint8Array | null = null,
    identity: StateIdentity | null = null;
  const knownId = performanceEngineId(module),
    engineId = knownId ?? options.engineId;
  if (knownId && options.engineId && options.engineId !== knownId) {
    x.ic_performance_free(handle);
    x.ic_speaker_free(speaker);
    throw new Error("chimera-kit: module identity mismatch");
  }
  let restored = 0;
  try {
    if (options.captureState || options.state) {
      if (!engineId) throw new Error("chimera-kit: transferred modules require engineId for portable state");
      const initial = new Uint8Array(x.memory.buffer).slice();
      const baseHash = new Uint8Array(await crypto.subtle.digest("SHA-256", initial));
      identity = { engineId, baseHash, speaker, handle, samples: Math.round(performance.duration * 48000) };
      if (options.captureState) base = initial;
      if (options.state) restored = await importState(x.memory, options.state, identity);
    }
  } catch (error) {
    x.ic_performance_free(handle);
    x.ic_speaker_free(speaker);
    throw error;
  }
  let position = restored,
    freed = false;
  const alive = () => {
    if (freed) throw new Error("chimera-kit: performance renderer was freed");
  };
  return {
    sampleRate: 48000,
    samples: Math.round(performance.duration * 48000),
    get position() {
      return position;
    },
    next(max = 4096) {
      alive();
      if (!Number.isInteger(max) || max < 1) throw new Error("chimera-kit: max must be a positive integer");
      const n = x.ic_performance_render(speaker, handle, Math.min(4096, max));
      if (n < 0) throw error();
      position += n;
      return n ? new Float32Array(x.memory.buffer, x.ic_performance_buffer(handle), n) : null;
    },
    telemetry() {
      alive();
      const at = x.ic_performance_telemetry(handle);
      return parseTelemetry(new Float32Array(x.memory.buffer, at, x.ic_performance_telemetry_len(handle)));
    },
    async exportState() {
      alive();
      if (!base || !identity) throw new Error("chimera-kit: captureState was not enabled");
      return exportState(new Uint8Array(x.memory.buffer), base, identity, position);
    },
    checkpoint() {
      alive();
      x.ic_performance_checkpoint(handle);
    },
    restore(sample) {
      alive();
      if (!Number.isInteger(sample) || sample < 0 || sample > Math.round(performance.duration * 48000))
        throw new Error("chimera-kit: restore sample is out of range");
      position = x.ic_performance_restore(handle, sample);
      return position;
    },
    free() {
      if (freed) return;
      freed = true;
      x.ic_performance_free(handle);
      x.ic_speaker_free(speaker);
    },
  };
}
