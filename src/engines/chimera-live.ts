/**
 * The CHIMERA engine's held, playable voice: `ic_live_*`/`ic_beat_*` in `crates/intone-chimera/src/abi.rs`.
 *
 * This file only loads the engine and moves bytes; it runs equally on the main thread (for tests,
 * or a caller with no AudioWorklet) and inside the worklet (`../worklet-live.ts`), which is where
 * `chimera-kit/live` actually renders.
 */

/** Must match `ABI_VERSION` in `abi.rs`. */
const ABI_VERSION = 5;
/** Must match `CHUNK` in `abi.rs`. */
const MAX_CHUNK = 4096;

/** Bytes, or a location to fetch them from. */
export type Source = URL | string | ArrayBuffer | Uint8Array;

export interface ChimeraLiveSources {
  /** The engine. Defaults to `chimera.wasm` next to this module (the same file the
   * utterance API uses: `ic_live_*` lives in the same wasm as `ic_utterance_*`). */
  wasm?: Source;
}

/** Who speaks: a named body, or a blend of them (mirrors `crate::Body` in `lib.rs`). */
export type Body = "male" | "female" | "child" | { female: number; child: number };

/**
 * A mouth shape: the engine's own articulators (`ArticKey`, camelCase), each roughly 0..1 unless
 * noted otherwise by `docs/rust-engine.md`. Every field is optional: only the ones given move.
 */
export interface ArticValues {
  jaw?: number;
  tbX?: number;
  tbY?: number;
  ttX?: number;
  ttY?: number;
  ttCurl?: number;
  root?: number;
  lipAp?: number;
  lipProt?: number;
  lipWidth?: number;
  labiodental?: number;
  velum?: number;
  larynx?: number;
  epilarynx?: number;
  ventricular?: number;
  lateral?: number;
  dorsum?: number;
}

export interface ShapeOptions {
  /** The tongue tip moves on its own instead of tracking the tongue body. */
  tipFree?: boolean;
}

/** The glottal source's own fields (`SourcePatch` in `human_voice.rs`). Every field is optional. */
export interface SourceValues {
  f0?: number;
  glide?: number;
  pressure?: number;
  breathiness?: number;
  tension?: number;
  fry?: number;
  roughness?: number;
  vibratoDepth?: number;
  vibratoRate?: number;
  drift?: number;
  voiced?: boolean;
  brightness?: number;
}

/** One beatbox hit, by pattern symbol or sound name ("kick" or "B"), case-insensitively either way. */
export interface BeatHit {
  id: string;
  note?: number;
  accent?: number;
}

export interface BeatTempo {
  bpm?: number;
  swing?: number;
}

/**
 * Messages between the page and the worklet (`../live.ts` and `../worklet-live.ts`), kept here so
 * neither of those two entry-point files has to import the other for its types alone.
 */
export type ToLive =
  | { type: "setBody"; body: Body }
  | { type: "shape"; values: ArticValues; options?: ShapeOptions }
  | { type: "source"; values: SourceValues }
  | { type: "vowel"; ipa: string }
  | { type: "noteOn"; midi: number; velocity?: number }
  | { type: "noteOff" }
  | { type: "bend"; midi: number }
  | { type: "beatHit"; hit: BeatHit }
  | { type: "beatSteps"; pattern: string }
  | { type: "beatTempo"; tempo: BeatTempo }
  | { type: "beatPlaying"; playing: boolean }
  | { type: "free" };

/** Messages the processor sends back up to the page. */
export type FromLive =
  | { type: "ready" }
  | { type: "telemetry"; data: LiveTelemetry }
  | { type: "error"; message: string; request?: ToLive };

/** A telemetry snapshot: see `live::pack_telemetry` in `live.rs` for the wire layout this parses. */
export interface LiveTelemetry {
  pharynxLength: number;
  mouthLength: number;
  velumPortArea: number;
  f0: number;
  voicing: number;
  lungPressure: number;
  outputRms: number;
  noiseLevel: number;
  noiseNode: number;
  gate: number;
  /** The voice's own clock (s). */
  clock: number;
  /** The beatbox sequencer's current step, or -1 while stopped. */
  beatStep: number;
  artic: Float32Array;
  pharynxAreas: Float32Array;
  mouthAreas: Float32Array;
  pressureRms: Float32Array;
  flow: Float32Array;
  glottalArea: Float32Array;
  glottalFlow: Float32Array;
}

interface Exports {
  memory: WebAssembly.Memory;
  ic_abi_version(): number;
  ic_alloc(n: number): number;
  ic_free(p: number, n: number): void;
  ic_live_new(sampleRate: number): number;
  ic_live_free(h: number): void;
  ic_live_error_ptr(h: number): number;
  ic_live_error_len(h: number): number;
  ic_live_set_body(h: number, json: number, len: number): number;
  ic_live_shape(h: number, json: number, len: number): number;
  ic_live_source(h: number, json: number, len: number): number;
  ic_live_vowel(h: number, ipa: number, len: number): number;
  ic_live_note_on(h: number, midi: number, velocity: number): number;
  ic_live_note_off(h: number): void;
  ic_live_bend(h: number, midi: number): number;
  ic_live_render(h: number, max: number): number;
  ic_live_buffer(h: number): number;
  ic_live_telemetry(h: number): number;
  ic_live_telemetry_len(h: number): number;
  ic_beat_hit(h: number, json: number, len: number): number;
  ic_beat_steps(h: number, text: number, len: number): number;
  ic_beat_tempo(h: number, json: number, len: number): number;
  ic_beat_playing(h: number, playing: number): void;
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
  const pointer = x.ic_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}

/**
 * `TextEncoder`/`TextDecoder`, falling back to a plain UTF-8 codec by hand: Chromium's
 * `AudioWorkletGlobalScope` has neither (confirmed: `new TextEncoder()` throws
 * "TextEncoder is not defined" there, silently dropping every JSON-encoded setter and `vowel`,
 * `beatSteps`, and the text of a thrown error, while WebKit's worklet scope has both). Every
 * control call that carries text goes through these two, never the globals directly.
 */
function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f),
      );
      i += 3;
    } else {
      out += String.fromCodePoint(
        ((b0 & 0x07) << 18) |
          (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
          (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
          ((bytes[i + 3] ?? 0) & 0x3f),
      );
      i += 4;
    }
  }
  return out;
}

/**
 * `Number.isFinite` for every number a patch carries. JSON itself cannot carry NaN or Infinity
 * (`JSON.stringify(NaN)` is `"null"`, same as Rust's `serde_json`), so a non-finite value here
 * would silently become a no-op field on the wasm side instead of the clear rejection a caller
 * gets from `noteOn`/`bend` (plain numbers, not JSON, so NaN survives to the wasm's own check).
 */
function assertFinite(label: string, values: object): void {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`chimera-kit: ${label}.${key} must be finite, got ${value}`);
    }
  }
}

/**
 * Compiles the engine's wasm once. Shared by `loadLiveEngine` and `chimera-kit/live`'s main-thread
 * side, which passes the compiled module (or, failing that, the raw bytes) to the worklet through
 * `AudioWorkletNode`'s `processorOptions`.
 */
export async function compileLiveWasm(
  source?: Source,
): Promise<{ module: WebAssembly.Module; bytes: Uint8Array }> {
  const bytes = await readBytes(source ?? new URL("./chimera.wasm", import.meta.url));
  const module = await WebAssembly.compile(bytes as BufferSource);
  return { module, bytes };
}

/** One held, played voice and its beatbox: one `Engine` underneath, moved by short calls. */
export class ChimeraLiveEngine {
  readonly maxChunk = MAX_CHUNK;
  private readonly handle: number;

  constructor(
    private readonly x: Exports,
    readonly sampleRate: number,
  ) {
    this.handle = x.ic_live_new(sampleRate);
  }

  setBody(body: Body): void {
    this.apply(this.x.ic_live_set_body, body);
  }

  shape(values: ArticValues, options?: ShapeOptions): void {
    assertFinite("shape", values);
    const request: { values: ArticValues; tipFree?: boolean } = { values };
    if (options?.tipFree !== undefined) request.tipFree = options.tipFree;
    this.apply(this.x.ic_live_shape, request);
  }

  source(values: SourceValues): void {
    assertFinite("source", values);
    this.apply(this.x.ic_live_source, values);
  }

  vowel(ipa: string): void {
    const { x, handle } = this;
    const bytes = utf8Encode(ipa);
    const pointer = copyIn(x, bytes);
    const ok = x.ic_live_vowel(handle, pointer, bytes.length);
    x.ic_free(pointer, bytes.length);
    if (!ok) throw new Error(this.lastError());
  }

  /** Starts a note: `velocity` is the breath gate (0..1.5; 1, the default, is a plain note). */
  noteOn(midi: number, velocity = 1): void {
    if (!Number.isFinite(midi)) throw new Error(`chimera-kit: note must be finite, got ${midi}`);
    if (!Number.isFinite(velocity)) throw new Error(`chimera-kit: velocity must be finite, got ${velocity}`);
    if (!this.x.ic_live_note_on(this.handle, midi, velocity)) throw new Error(this.lastError());
  }

  noteOff(): void {
    this.x.ic_live_note_off(this.handle);
  }

  /** Glides to a new pitch while a note is held, without retriggering the gate. */
  bend(midi: number): void {
    if (!Number.isFinite(midi)) throw new Error(`chimera-kit: note must be finite, got ${midi}`);
    if (!this.x.ic_live_bend(this.handle, midi)) throw new Error(this.lastError());
  }

  /** Renders up to `max` (at most `maxChunk`) samples; the view is valid until the next call that
   * touches this engine's buffer (another `render`, or `free`). */
  render(max: number): Float32Array {
    const { x, handle } = this;
    const n = x.ic_live_render(handle, max);
    return new Float32Array(x.memory.buffer, x.ic_live_buffer(handle), n);
  }

  telemetry(): LiveTelemetry {
    const { x, handle } = this;
    const pointer = x.ic_live_telemetry(handle);
    const data = new Float32Array(x.memory.buffer, pointer, x.ic_live_telemetry_len(handle));
    return parseTelemetry(data);
  }

  beatHit(hit: BeatHit): void {
    this.apply(this.x.ic_beat_hit, hit);
  }

  /** Replaces the sequencer's pattern, by pattern symbol ("B . t .") or sound name
   * ("kick . snare ."), as `live::set_beat_steps` resolves either. */
  beatSteps(pattern: string): void {
    const { x, handle } = this;
    const bytes = utf8Encode(pattern);
    const pointer = copyIn(x, bytes);
    const ok = x.ic_beat_steps(handle, pointer, bytes.length);
    x.ic_free(pointer, bytes.length);
    if (!ok) throw new Error(this.lastError());
  }

  beatTempo(tempo: BeatTempo): void {
    this.apply(this.x.ic_beat_tempo, tempo);
  }

  beatPlaying(playing: boolean): void {
    this.x.ic_beat_playing(this.handle, playing ? 1 : 0);
  }

  /** Frees the engine. Safe to call while a note sounds or the beat plays. */
  free(): void {
    this.x.ic_live_free(this.handle);
  }

  /** Every JSON-encoded setter: parse and validate on the wasm side, only then mutate, so
   * rejected input (a 0 return) never reaches `Engine`. */
  private apply(call: (h: number, json: number, len: number) => number, value: unknown): void {
    const { x, handle } = this;
    const json = utf8Encode(JSON.stringify(value));
    const pointer = copyIn(x, json);
    const ok = call(handle, pointer, json.length);
    x.ic_free(pointer, json.length);
    if (!ok) throw new Error(this.lastError());
  }

  private lastError(): string {
    const { x, handle } = this;
    const pointer = x.ic_live_error_ptr(handle);
    const bytes = new Uint8Array(x.memory.buffer, pointer, x.ic_live_error_len(handle));
    return `chimera-kit: ${utf8Decode(bytes)}`;
  }
}

/** Fields before each array, in the order `live::pack_telemetry` writes them. */
const TELEMETRY_HEADER = 19;

function parseTelemetry(data: Float32Array): LiveTelemetry {
  let at = TELEMETRY_HEADER;
  const take = (n: number): Float32Array => {
    const slice = data.slice(at, at + n);
    at += n;
    return slice;
  };
  return {
    pharynxLength: data[0] ?? 0,
    mouthLength: data[1] ?? 0,
    velumPortArea: data[2] ?? 0,
    f0: data[3] ?? 0,
    voicing: data[4] ?? 0,
    lungPressure: data[5] ?? 0,
    outputRms: data[6] ?? 0,
    noiseLevel: data[7] ?? 0,
    noiseNode: data[8] ?? 0,
    gate: data[9] ?? 0,
    clock: data[10] ?? 0,
    beatStep: data[11] ?? 0,
    artic: take(data[12] ?? 0),
    pharynxAreas: take(data[13] ?? 0),
    mouthAreas: take(data[14] ?? 0),
    pressureRms: take(data[15] ?? 0),
    flow: take(data[16] ?? 0),
    glottalArea: take(data[17] ?? 0),
    glottalFlow: take(data[18] ?? 0),
  };
}

/** Instantiates an already-compiled module at `sampleRate` (the ABI's own version is checked
 * first). This is the worklet's fast path: the module crossed from the main thread without
 * recompiling. */
export async function instantiateLive(
  module: WebAssembly.Module,
  sampleRate: number,
): Promise<ChimeraLiveEngine> {
  const instance = await WebAssembly.instantiate(module, {});
  const x = instance.exports as unknown as Exports;
  if (x.ic_abi_version() !== ABI_VERSION) {
    throw new Error(`chimera-kit: engine ABI ${x.ic_abi_version()}, expected ${ABI_VERSION}`);
  }
  return new ChimeraLiveEngine(x, sampleRate);
}

/** Loads the engine directly, for calling from any thread with no AudioWorklet (tests, Node/Bun,
 * or a caller that renders itself). `chimera-kit/live` runs this same class inside an
 * AudioWorkletProcessor instead; see `worklet-live.ts`. */
export async function loadLiveEngine(
  sources: ChimeraLiveSources = {},
  sampleRate = 48_000,
): Promise<ChimeraLiveEngine> {
  const { module } = await compileLiveWasm(sources.wasm);
  return instantiateLive(module, sampleRate);
}
