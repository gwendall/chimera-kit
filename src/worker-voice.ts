/**
 * A voice that computes in a Worker, so speaking costs the page's thread almost nothing: it only
 * passes the chunks on to the player.
 */
import type { CreateVoiceOptions } from "./index.js";
import type { Rendered, StreamOptions } from "./voice.js";
import type { FromWorker, ToWorker } from "./worker.js";

export interface WorkerVoiceOptions extends CreateVoiceOptions {
  /**
   * The worker to use, running intone's `worker.js`. Defaults to a new module worker next to this
   * file, which bundlers that follow `new URL(..., import.meta.url)` pick up.
   */
  worker?: Worker;
}

/** A voice whose samples arrive asynchronously. */
export interface AsyncVoice {
  readonly sampleRate: number;
  render(text: string, options?: StreamOptions): Promise<Rendered>;
  /** Chunks as the worker computes them. Ending the loop early cancels the rest. */
  stream(text: string, options?: StreamOptions): AsyncGenerator<Float32Array, void, undefined>;
  /** Stops the worker. */
  free(): void;
}

/** Starts a worker, loads the engine in it, and returns its voice. */
export async function createWorkerVoice(options: WorkerVoiceOptions = {}): Promise<AsyncVoice> {
  const { worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }), ...rest } =
    options;
  const send = (request: ToWorker) => worker.postMessage(request);
  const listeners = new Map<number, (reply: FromWorker) => void>();
  let failure: Error | undefined;
  let opened: ((sampleRate: number) => void) | undefined;
  let refused: ((error: Error) => void) | undefined;

  const fail = (error: Error) => {
    failure = error;
    refused?.(error);
    for (const listener of listeners.values()) listener({ type: "error", message: error.message });
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    fail(new Error(`intone: the worker failed${event.message ? `: ${event.message}` : ""}`));
  };
  worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
    if (data.type === "ready") opened?.(data.sampleRate);
    else if (data.id === undefined) fail(new Error(data.type === "error" ? data.message : "intone: no id"));
    else listeners.get(data.id)?.(data);
  };

  const sampleRate = await new Promise<number>((resolve, reject) => {
    opened = resolve;
    refused = reject;
    send({ type: "open", options: cloneable(rest) });
  });
  refused = undefined;

  let next = 0;
  let freed = false;
  const check = () => {
    if (freed) throw new Error("intone: this voice has been freed");
    if (failure) throw failure;
  };

  return {
    sampleRate,

    render(text, speak = {}) {
      check();
      const id = ++next;
      return new Promise<Rendered>((resolve, reject) => {
        listeners.set(id, (reply) => {
          listeners.delete(id);
          if (reply.type === "rendered") resolve({ audio: reply.audio, sampleRate });
          else reject(new Error(reply.type === "error" ? reply.message : `intone: unexpected ${reply.type}`));
        });
        send({ type: "render", id, text, options: speak });
      });
    },

    async *stream(text, speak = {}) {
      check();
      const id = ++next;
      const chunks: Float32Array[] = [];
      let ended = false;
      let error: Error | undefined;
      let wake: (() => void) | undefined;
      listeners.set(id, (reply) => {
        if (reply.type === "chunk") chunks.push(reply.chunk);
        else if (reply.type === "end") ended = true;
        else if (reply.type === "error") error = new Error(reply.message);
        wake?.();
      });
      send({ type: "stream", id, text, options: speak });
      try {
        for (;;) {
          const chunk = chunks.shift();
          if (chunk) {
            yield chunk;
            continue;
          }
          if (error) throw error;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      } finally {
        listeners.delete(id);
        if (!ended && !error) send({ type: "cancel", id });
      }
    },

    free() {
      if (freed) return;
      freed = true;
      send({ type: "free" });
    },
  };
}

/** Options that survive postMessage: URLs become absolute strings, as the worker resolves elsewhere. */
function cloneable(options: CreateVoiceOptions): CreateVoiceOptions {
  const absolute = <T>(source: T): T | string => {
    if (!(source instanceof URL || typeof source === "string")) return source;
    try {
      return new URL(String(source), globalThis.location?.href).href;
    } catch {
      return String(source); // relative, and no page to resolve it against
    }
  };
  const out = { ...options };
  if (out.wasm !== undefined) out.wasm = absolute(out.wasm);
  if (out.dictionary !== undefined && out.dictionary !== false) out.dictionary = absolute(out.dictionary);
  return out;
}
