/**
 * chimera-speak: text to speech from a simulated airway, in about a megabyte.
 *
 * The engine is Rust compiled to WebAssembly. This file only loads it and moves bytes.
 */

/** Must match `ABI_VERSION` in `crates/chimera-speak/src/abi.rs`. */
const ABI_VERSION = 1;

/** Bytes, or a location to fetch them from. */
export type Source = URL | string | ArrayBuffer | Uint8Array;

/** Who speaks: a named body, or a blend (each weight from 0 to 1). */
export type Body = "male" | "female" | "child" | { female: number; child: number };

export interface SpeakOptions {
  body?: Body;
  /** Speaking-rate multiplier, above 1 is faster. Up to 4. */
  rate?: number;
  /** Baseline pitch in Hz. Defaults to the body's own. */
  f0?: number;
  /** Pitch excursion on stressed syllables, as a fraction. */
  accent?: number;
}

export interface CreateVoiceOptions extends SpeakOptions {
  /** The engine. Defaults to `chimera_speak.wasm` next to this module. */
  wasm?: Source;
  /**
   * The pronouncing dictionary (CMUdict, gzipped or plain). Defaults to `cmudict.txt.gz` next to
   * this module. `false` skips it: words are then pronounced from spelling rules, for about
   * 870 KB less to download.
   */
  dictionary?: Source | false;
}

export interface Rendered {
  /** Mono samples, nominally within -1 to 1. */
  audio: Float32Array;
  sampleRate: number;
}

export interface Voice {
  readonly sampleRate: number;
  /** Renders the whole utterance at once. */
  render(text: string, options?: SpeakOptions): Rendered;
  /** Renders chunk by chunk. Each chunk is a fresh array the caller owns. */
  stream(text: string, options?: SpeakOptions): Generator<Float32Array, void, undefined>;
  /** Releases the voice's memory. It can't be used afterwards. */
  free(): void;
}

interface Exports {
  memory: WebAssembly.Memory;
  cs_abi_version(): number;
  cs_sample_rate(): number;
  cs_alloc(n: number): number;
  cs_free(p: number, n: number): void;
  cs_speaker_new(): number;
  cs_speaker_free(s: number): void;
  cs_speaker_load_dictionary(s: number, text: number, len: number): number;
  cs_speaker_error_ptr(s: number): number;
  cs_speaker_error_len(s: number): number;
  cs_utterance_new(s: number, json: number, len: number): number;
  cs_utterance_free(u: number): void;
  cs_utterance_samples(u: number): number;
  cs_utterance_render(u: number): number;
  cs_utterance_buffer(u: number): number;
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
  if (!response.ok) throw new Error(`chimera-speak: ${url} answered ${response.status}`);
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
  const pointer = x.cs_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}

class WasmVoice implements Voice {
  private speaker: number;

  constructor(
    private readonly x: Exports,
    private readonly defaults: SpeakOptions,
  ) {
    this.speaker = x.cs_speaker_new();
  }

  get sampleRate(): number {
    return this.x.cs_sample_rate();
  }

  loadDictionary(text: Uint8Array): void {
    const { x } = this;
    const pointer = copyIn(x, text);
    const ok = x.cs_speaker_load_dictionary(this.liveSpeaker(), pointer, text.length);
    x.cs_free(pointer, text.length);
    if (!ok) throw new Error(this.lastError());
  }

  render(text: string, options?: SpeakOptions): Rendered {
    const { x } = this;
    const utterance = this.begin(text, options);
    try {
      const audio = new Float32Array(x.cs_utterance_samples(utterance));
      let at = 0;
      for (let n = x.cs_utterance_render(utterance); n > 0; n = x.cs_utterance_render(utterance)) {
        audio.set(new Float32Array(x.memory.buffer, x.cs_utterance_buffer(utterance), n), at);
        at += n;
      }
      return { audio, sampleRate: this.sampleRate };
    } finally {
      x.cs_utterance_free(utterance);
    }
  }

  *stream(text: string, options?: SpeakOptions): Generator<Float32Array, void, undefined> {
    const { x } = this;
    const utterance = this.begin(text, options);
    try {
      for (let n = x.cs_utterance_render(utterance); n > 0; n = x.cs_utterance_render(utterance)) {
        yield new Float32Array(x.memory.buffer, x.cs_utterance_buffer(utterance), n).slice();
      }
    } finally {
      x.cs_utterance_free(utterance);
    }
  }

  free(): void {
    if (this.speaker === 0) return;
    this.x.cs_speaker_free(this.speaker);
    this.speaker = 0;
  }

  private begin(text: string, options?: SpeakOptions): number {
    const { x } = this;
    const json = new TextEncoder().encode(JSON.stringify({ ...this.defaults, ...options, text }));
    const pointer = copyIn(x, json);
    const utterance = x.cs_utterance_new(this.liveSpeaker(), pointer, json.length);
    x.cs_free(pointer, json.length);
    if (utterance === 0) throw new Error(this.lastError());
    return utterance;
  }

  private liveSpeaker(): number {
    if (this.speaker === 0) throw new Error("chimera-speak: this voice has been freed");
    return this.speaker;
  }

  private lastError(): string {
    const { x } = this;
    const pointer = x.cs_speaker_error_ptr(this.speaker);
    const bytes = new Uint8Array(x.memory.buffer, pointer, x.cs_speaker_error_len(this.speaker));
    return `chimera-speak: ${new TextDecoder().decode(bytes)}`;
  }
}

/** Loads the engine and returns a voice. */
export async function createVoice(options: CreateVoiceOptions = {}): Promise<Voice> {
  const { wasm, dictionary, ...defaults } = options;
  const [wasmBytes, dictionaryBytes] = await Promise.all([
    readBytes(wasm ?? new URL("./chimera_speak.wasm", import.meta.url)),
    dictionary === false ? null : readBytes(dictionary ?? new URL("./cmudict.txt.gz", import.meta.url)),
  ]);
  const module = await WebAssembly.compile(wasmBytes as BufferSource);
  const instance = await WebAssembly.instantiate(module, {});
  const x = instance.exports as unknown as Exports;
  if (x.cs_abi_version() !== ABI_VERSION) {
    throw new Error(`chimera-speak: engine ABI ${x.cs_abi_version()}, expected ${ABI_VERSION}`);
  }
  const voice = new WasmVoice(x, defaults);
  if (dictionaryBytes) voice.loadDictionary(await decodeText(dictionaryBytes));
  return voice;
}
