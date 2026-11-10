/**
 * CHIMERA's non-human creatures: a songbird, a seal, an alligator, an elephant, each with its own
 * simulated airway and a few recorded calls. A second, smaller engine from `chimera-kit/creatures`,
 * independent of speech.
 */

/** Must match `ABI_VERSION` in `crates/intone-creatures/src/abi.rs`. */
const ABI_VERSION = 1;
/** Must match `CHUNK` in `abi.rs`. */
const MAX_CHUNK = 4096;
/** Granularity for the quiet-tail search in `call`/`stream`; well under `MAX_CHUNK`. */
const RENDER_STEP = 256;
/** -60 dBFS, as a peak amplitude. */
const QUIET_AMPLITUDE = 10 ** (-60 / 20);
/** How long a call must stay under `QUIET_AMPLITUDE` to count as finished. */
const QUIET_SECONDS = 0.05;
/** The longest a call's release tail is allowed to run past its last key. */
const MAX_TAIL_SECONDS = 2;
/** A call's automation holds this long past its last key (see `CreatureVoice::eval_call`). */
const CALL_END_SLACK_SECONDS = 0.05;

/** Bytes, or a location to fetch them from. */
export type Source = URL | string | ArrayBuffer | Uint8Array;

export interface CreaturesSources {
  /** The engine. Defaults to `creatures.wasm` next to this module. */
  wasm?: Source;
}

/** A playable parameter: `set({[key]: value})` clamps to `[min, max]`. */
export interface CreatureParam {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  log?: boolean;
  /** Smoothing time constant, in seconds. */
  smooth?: number;
  /** `"pitch"`: this param follows a call's `pitch` option, scaled from the call's own reference. */
  role?: "pitch";
  /** Decimals for display. */
  digits?: number;
}

/** Points of a curve over time: `[seconds, value]`, linear between points, held past the ends. */
export type CreatureCurve = "lin" | "exp" | "step";

/** One keyframe of a call's automation: at `t` seconds, set each named value (a param's key,
 * `"gate"`, or `"!event"`), interpolated from the previous key by `curve` (default linear). */
export interface CreatureCallKey {
  t: number;
  v: Record<string, number>;
  curve?: CreatureCurve;
}

/** One playable call: a short performance of keyed parameter and gate automation. */
export interface CreatureCall {
  id: string;
  name: string;
  /** A one-line description of what the call sounds like. */
  hint: string;
  keys: CreatureCallKey[];
  /** When given, a call's `pitch` option scales pitch params by `pitch / pitchRef`. */
  pitchRef?: number;
}

export type CreatureGroup =
  | "human"
  | "bird"
  | "mammal"
  | "marine"
  | "reptile"
  | "amphibian"
  | "insect"
  | "crustacean"
  | "fantasy";

/** What a creature is and what it can do, as the catalog describes it. */
export interface CreatureInfo {
  id: string;
  name: string;
  latin: string;
  group: CreatureGroup;
  /** How it makes sound, one sentence. */
  blurb: string;
  /** Its musical role in a track. */
  role: string;
  oversample: number;
  gateTimes?: { attack: number; release: number };
  params: CreatureParam[];
  calls: CreatureCall[];
}

export interface CallOptions {
  /** Hz; omit (or NaN) for the call's own pitch. */
  pitch?: number;
  /** Defaults to 1. */
  amp?: number;
}

export interface StreamOptions extends CallOptions {
  /** Samples per chunk. Defaults to 1024. */
  chunkSize?: number;
}

export interface Creature {
  readonly info: CreatureInfo;
  /** Sets performer parameters by key, clamped to each one's range. Unknown keys throw. */
  set(params: Record<string, number>): void;
  /** Sets the breath gate, 0 to 1 (clamped to 1.5 to allow a small overdrive). */
  gate(level: number): void;
  /** Renders `samples` of continuous audio at the current parameters and gate, for playing the
   * creature live, like an instrument. `samples` must be a nonnegative safe integer. */
  render(samples: number): Float32Array;
  /**
   * Plays a call to completion and returns every sample: the call itself, plus its release tail
   * until it goes quiet (below -60 dBFS for 50 ms), capped at 2 s past the call's last key.
   */
  call(id: string, options?: CallOptions): Float32Array;
  /** The same samples as {@link call}, as a generator of chunks (`chunkSize` samples each). */
  stream(id: string, options?: StreamOptions): Generator<Float32Array>;
  /** Ends the active call early; the gate then releases as it would at the call's own end. */
  stop(): void;
  free(): void;
}

export interface Creatures {
  readonly sampleRate: number;
  readonly list: CreatureInfo[];
  /** Creates a creature by id, with optional starting parameter values (by key). */
  create(id: string, params?: Record<string, number>): Creature;
}

interface Exports {
  memory: WebAssembly.Memory;
  cc_abi_version(): number;
  cc_sample_rate(): number;
  cc_alloc(n: number): number;
  cc_free(p: number, n: number): void;
  cc_catalog_ptr(): number;
  cc_catalog_len(): number;
  cc_creature_new(id: number, len: number): number;
  cc_creature_free(h: number): void;
  cc_creature_param(h: number, index: number, value: number): void;
  cc_creature_gate(h: number, level: number): void;
  cc_creature_call(h: number, index: number, pitch: number, amp: number): void;
  cc_creature_stop(h: number): void;
  cc_creature_active(h: number): number;
  cc_creature_render(h: number, n: number): number;
  cc_creature_buffer(h: number): number;
}

async function readBytes(source: Source): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const url = new URL(String(source), globalThis.location?.href);
  if (url.protocol === "file:") {
    // Node's fetch has no file: scheme. The variable keeps bundlers from resolving the import.
    const fs = "node:fs/promises";
    const { readFile } = await import(/* @vite-ignore */ fs);
    return new Uint8Array(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`chimera-kit: ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function copyIn(x: Exports, bytes: Uint8Array): number {
  const pointer = x.cc_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}

function join(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A NaN or infinite control would poison the simulation's state for good. */
function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`chimera-kit: ${name} must be finite, got ${value}`);
}

function unknownCallError(info: CreatureInfo, id: string): Error {
  const known = info.calls.map((c) => c.id).join(", ");
  return new Error(`chimera-kit: ${info.id} has no call '${id}'; known calls: ${known}`);
}

class CreatureImpl implements Creature {
  private readonly paramIndex: Map<string, number>;
  private freed = false;

  constructor(
    private readonly x: Exports,
    private readonly handle: number,
    private readonly sampleRate: number,
    readonly info: CreatureInfo,
  ) {
    this.paramIndex = new Map(info.params.map((p, i) => [p.key, i]));
  }

  /** A freed handle is dangling memory in the wasm: refuse it here rather than corrupt the heap. */
  private check(): void {
    if (this.freed) throw new Error("chimera-kit: this creature has been freed");
  }

  set(params: Record<string, number>): void {
    this.check();
    const { x, handle, info } = this;
    for (const [key, value] of Object.entries(params)) {
      const index = this.paramIndex.get(key);
      if (index === undefined) {
        const known = info.params.map((p) => p.key).join(", ");
        throw new Error(`chimera-kit: ${info.id} has no parameter '${key}'; known parameters: ${known}`);
      }
      finite(key, value);
      x.cc_creature_param(handle, index, value);
    }
  }

  gate(level: number): void {
    this.check();
    finite("gate", level);
    this.x.cc_creature_gate(this.handle, level);
  }

  render(samples: number): Float32Array {
    this.check();
    if (!Number.isSafeInteger(samples) || samples < 0) {
      throw new RangeError(`chimera-kit: samples must be a nonnegative safe integer, got ${samples}`);
    }
    const { x, handle } = this;
    const out = new Float32Array(samples);
    let at = 0;
    while (at < samples) {
      const n = x.cc_creature_render(handle, Math.min(MAX_CHUNK, samples - at));
      out.set(new Float32Array(x.memory.buffer, x.cc_creature_buffer(handle), n), at);
      at += n;
    }
    return out;
  }

  call(id: string, options: CallOptions = {}): Float32Array {
    const steps = [...this.steps(id, options)];
    return join(
      steps,
      steps.reduce((total, step) => total + step.length, 0),
    );
  }

  *stream(id: string, options: StreamOptions = {}): Generator<Float32Array> {
    const chunkSize = options.chunkSize ?? 1024;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError(`chimera-kit: chunkSize must be a positive integer, got ${chunkSize}`);
    }
    // Computed step by step, as the caller reads it: the first chunk waits for one chunk's worth of
    // sound, not for the whole call.
    let chunk = new Float32Array(chunkSize);
    let filled = 0;
    for (const step of this.steps(id, options)) {
      let at = 0;
      while (at < step.length) {
        const n = Math.min(step.length - at, chunkSize - filled);
        chunk.set(step.subarray(at, at + n), filled);
        filled += n;
        at += n;
        if (filled === chunkSize) {
          yield chunk;
          chunk = new Float32Array(chunkSize);
          filled = 0;
        }
      }
    }
    if (filled > 0) yield chunk.subarray(0, filled);
  }

  stop(): void {
    this.check();
    this.x.cc_creature_stop(this.handle);
  }

  free(): void {
    if (this.freed) return;
    this.freed = true;
    this.x.cc_creature_free(this.handle);
  }

  /** Computes a whole call step by step: the active portion (computed from the catalog, so it never depends on
   * how finely we poll the engine), then the release tail, sample-stepped until it is quiet or
   * the tail cap is reached. The result is the same whatever `stream`'s `chunkSize` later is. */
  private *steps(id: string, options: CallOptions): Generator<Float32Array> {
    this.check();
    const call = this.info.calls.find((c) => c.id === id);
    if (!call) throw unknownCallError(this.info, id);
    const index = this.info.calls.indexOf(call);
    if (options.pitch !== undefined) finite("pitch", options.pitch);
    if (options.amp !== undefined) finite("amp", options.amp);

    const { x, handle, sampleRate } = this;
    const lastKeyT = call.keys[call.keys.length - 1]?.t ?? 0;
    const activeSamples = Math.ceil((lastKeyT + CALL_END_SLACK_SECONDS) * sampleRate);
    const quietSamples = Math.round(sampleRate * QUIET_SECONDS);
    const maxTailSamples = Math.round(sampleRate * MAX_TAIL_SECONDS);

    x.cc_creature_call(handle, index, options.pitch ?? Number.NaN, options.amp ?? 1);

    const step = (n: number): Float32Array => {
      this.check(); // a caller reading a stream may free the creature between two chunks
      const got = x.cc_creature_render(handle, n);
      return new Float32Array(x.memory.buffer, x.cc_creature_buffer(handle), got).slice();
    };

    let rendered = 0;
    while (rendered < activeSamples) {
      const view = step(Math.min(RENDER_STEP, activeSamples - rendered));
      rendered += view.length;
      yield view;
    }

    let quietRun = 0;
    let tailRendered = 0;
    while (tailRendered < maxTailSamples && quietRun < quietSamples) {
      const view = step(Math.min(RENDER_STEP, maxTailSamples - tailRendered));
      tailRendered += view.length;
      for (const sample of view) {
        quietRun = Math.abs(sample) < QUIET_AMPLITUDE ? quietRun + 1 : 0;
        if (quietRun >= quietSamples) break;
      }
      yield view;
    }
  }
}

/** Loads the creatures engine. */
export async function loadCreatures(sources: CreaturesSources = {}): Promise<Creatures> {
  const { wasm } = sources;
  const wasmBytes = await readBytes(wasm ?? new URL("./creatures.wasm", import.meta.url));
  const module = await WebAssembly.compile(wasmBytes as BufferSource);
  const instance = await WebAssembly.instantiate(module, {});
  const x = instance.exports as unknown as Exports;
  if (x.cc_abi_version() !== ABI_VERSION) {
    throw new Error(`chimera-kit: creatures engine ABI ${x.cc_abi_version()}, expected ${ABI_VERSION}`);
  }

  // The catalog builds (and may grow memory) on this first call, so fetch it before `.buffer`.
  const catalogPtr = x.cc_catalog_ptr();
  const catalogLen = x.cc_catalog_len();
  const catalogBytes = new Uint8Array(x.memory.buffer, catalogPtr, catalogLen);
  const list = JSON.parse(new TextDecoder().decode(catalogBytes)) as CreatureInfo[];
  const byId = new Map(list.map((c) => [c.id, c]));
  const sampleRate = x.cc_sample_rate();

  function unknownCreatureError(id: string): Error {
    const known = list.map((c) => c.id).join(", ");
    return new Error(`chimera-kit: no creature '${id}'; known creatures: ${known}`);
  }

  return {
    sampleRate,
    list,
    create(id: string, params: Record<string, number> = {}): Creature {
      const info = byId.get(id);
      if (!info) throw unknownCreatureError(id);
      const bytes = new TextEncoder().encode(id);
      const pointer = copyIn(x, bytes);
      const handle = x.cc_creature_new(pointer, bytes.length);
      x.cc_free(pointer, bytes.length);
      // The catalog and the wasm agree in practice; this only guards drift between them.
      if (handle === 0) throw unknownCreatureError(id);
      const creature = new CreatureImpl(x, handle, sampleRate, info);
      try {
        creature.set(params);
      } catch (error) {
        creature.free();
        throw error;
      }
      return creature;
    },
  };
}
