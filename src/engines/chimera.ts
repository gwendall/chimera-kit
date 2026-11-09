/** The CHIMERA engine, compiled to WebAssembly. This file only loads it and moves bytes. */
import type { Engine, EngineRequest, EngineUtterance, ScoreRequest } from "../engine.js";
import type { Score } from "../layers.js";

/** Must match `ABI_VERSION` in `crates/intone-chimera/src/abi.rs`. */
const ABI_VERSION = 3;
/** Must match `CHUNK` in `abi.rs`. */
const MAX_CHUNK = 4096;

/** Bytes, or a location to fetch them from. */
export type Source = URL | string | ArrayBuffer | Uint8Array;

export interface ChimeraSources {
  /** The engine. Defaults to `intone_chimera.wasm` next to this module. */
  wasm?: Source;
  /**
   * The pronouncing dictionary (CMUdict, gzipped or plain). Defaults to `cmudict.txt.gz` next to
   * this module. `false` skips it: words are then pronounced from spelling rules, for about
   * 870 KB less to download.
   */
  dictionary?: Source | false;
}

interface Exports {
  memory: WebAssembly.Memory;
  ic_abi_version(): number;
  ic_sample_rate(): number;
  ic_alloc(n: number): number;
  ic_free(p: number, n: number): void;
  ic_speaker_new(): number;
  ic_speaker_free(s: number): void;
  ic_speaker_load_dictionary(s: number, text: number, len: number): number;
  ic_speaker_error_ptr(s: number): number;
  ic_speaker_error_len(s: number): number;
  ic_utterance_new(s: number, json: number, len: number): number;
  ic_speaker_plan(s: number, json: number, len: number): number;
  ic_speaker_plan_ptr(s: number): number;
  ic_speaker_plan_len(s: number): number;
  ic_utterance_new_from_score(s: number, json: number, len: number): number;
  ic_utterance_free(u: number): void;
  ic_utterance_samples(u: number): number;
  ic_utterance_render(u: number, max: number): number;
  ic_utterance_buffer(u: number): number;
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
  if (!response.ok) throw new Error(`intone: ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The bytes of a dictionary as text, gunzipping when needed (servers may have done it already). */
async function decodeText(bytes: Uint8Array): Promise<Uint8Array> {
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzipped) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function copyIn(x: Exports, bytes: Uint8Array): number {
  const pointer = x.ic_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}

class ChimeraUtterance implements EngineUtterance {
  constructor(
    private readonly x: Exports,
    private readonly pointer: number,
  ) {}

  get samples(): number {
    return this.x.ic_utterance_samples(this.pointer);
  }

  next(max: number): Float32Array | null {
    const { x, pointer } = this;
    const n = x.ic_utterance_render(pointer, max);
    return n > 0 ? new Float32Array(x.memory.buffer, x.ic_utterance_buffer(pointer), n) : null;
  }

  free(): void {
    this.x.ic_utterance_free(this.pointer);
  }
}

class ChimeraEngine implements Engine {
  readonly maxChunk = MAX_CHUNK;
  private readonly speaker: number;

  constructor(private readonly x: Exports) {
    this.speaker = x.ic_speaker_new();
  }

  get sampleRate(): number {
    return this.x.ic_sample_rate();
  }

  loadDictionary(text: Uint8Array): void {
    const { x } = this;
    const pointer = copyIn(x, text);
    const ok = x.ic_speaker_load_dictionary(this.speaker, pointer, text.length);
    x.ic_free(pointer, text.length);
    if (!ok) throw new Error(this.lastError());
  }

  begin(request: EngineRequest): EngineUtterance {
    const { x } = this;
    const json = new TextEncoder().encode(JSON.stringify(request));
    const pointer = copyIn(x, json);
    const utterance = x.ic_utterance_new(this.speaker, pointer, json.length);
    x.ic_free(pointer, json.length);
    if (utterance === 0) throw new Error(this.lastError());
    return new ChimeraUtterance(x, utterance);
  }

  plan(request: EngineRequest): Score {
    const { x } = this;
    const json = new TextEncoder().encode(JSON.stringify(request));
    const pointer = copyIn(x, json);
    const ok = x.ic_speaker_plan(this.speaker, pointer, json.length);
    x.ic_free(pointer, json.length);
    if (!ok) throw new Error(this.lastError());
    const ptr = x.ic_speaker_plan_ptr(this.speaker);
    const len = x.ic_speaker_plan_len(this.speaker);
    const bytes = new Uint8Array(x.memory.buffer, ptr, len);
    return JSON.parse(new TextDecoder().decode(bytes)) as Score;
  }

  beginScore(request: ScoreRequest): EngineUtterance {
    const { x } = this;
    const json = new TextEncoder().encode(JSON.stringify(request));
    const pointer = copyIn(x, json);
    const utterance = x.ic_utterance_new_from_score(this.speaker, pointer, json.length);
    x.ic_free(pointer, json.length);
    if (utterance === 0) throw new Error(this.lastError());
    return new ChimeraUtterance(x, utterance);
  }

  free(): void {
    this.x.ic_speaker_free(this.speaker);
  }

  private lastError(): string {
    const { x } = this;
    const pointer = x.ic_speaker_error_ptr(this.speaker);
    const bytes = new Uint8Array(x.memory.buffer, pointer, x.ic_speaker_error_len(this.speaker));
    return `intone: ${new TextDecoder().decode(bytes)}`;
  }
}

/** Loads the engine and its dictionary. */
export async function loadChimera(sources: ChimeraSources = {}): Promise<Engine> {
  const { wasm, dictionary } = sources;
  const [wasmBytes, dictionaryBytes] = await Promise.all([
    readBytes(wasm ?? new URL("./intone_chimera.wasm", import.meta.url)),
    dictionary === false ? null : readBytes(dictionary ?? new URL("./cmudict.txt.gz", import.meta.url)),
  ]);
  const module = await WebAssembly.compile(wasmBytes as BufferSource);
  const instance = await WebAssembly.instantiate(module, {});
  const x = instance.exports as unknown as Exports;
  if (x.ic_abi_version() !== ABI_VERSION) {
    throw new Error(`intone: engine ABI ${x.ic_abi_version()}, expected ${ABI_VERSION}`);
  }
  const engine = new ChimeraEngine(x);
  if (dictionaryBytes) engine.loadDictionary(await decodeText(dictionaryBytes));
  return engine;
}
