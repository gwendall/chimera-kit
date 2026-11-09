/**
 * A voice that computes in a Worker, so speaking costs the page's thread almost nothing. With
 * `say`, the samples go from the worker to the audio thread without passing through the page.
 */
import { type ClauseOptions, clauses } from "./clauses.js";
import type { Delivery, Mood } from "./delivery.js";
import type { CreateVoiceOptions } from "./index.js";
import { type Playback, type PlayOptions, playThrough } from "./player.js";
import type { Rendered, StreamOptions } from "./voice.js";
import type { FromWorker, ToWorker } from "./worker.js";

/** A delivery as data, for a worker or any engine: what `style: deliver(delivery, intensity)` does. */
export interface DeliveryOptions {
  /** A mood's name or plain numbers, applied to everything planned from text. */
  delivery?: Delivery | Mood;
  /** How far to take it: 0 is neutral, 1 as written (the default). */
  intensity?: number;
}

/**
 * A worker gets its options through postMessage, which cannot carry a function such as `style`:
 * a delivery comes as data instead.
 */
export type WorkerStreamOptions = Omit<StreamOptions, "style"> & DeliveryOptions;

export interface WorkerVoiceOptions extends Omit<CreateVoiceOptions, "style">, DeliveryOptions {
  /**
   * The worker to use, running intone's `worker.js`. Defaults to a new module worker next to this
   * file, which bundlers that follow `new URL(..., import.meta.url)` pick up.
   */
  worker?: Worker;
}

export interface SayOptions extends WorkerStreamOptions, Omit<PlayOptions, "ahead"> {
  /** How text that arrives in pieces is cut into clauses. */
  clauses?: ClauseOptions;
}

/** A voice whose samples arrive asynchronously. */
export interface AsyncVoice {
  readonly sampleRate: number;
  render(text: string, options?: WorkerStreamOptions): Promise<Rendered>;
  /** Chunks as the worker computes them. Ending the loop early cancels the rest. */
  stream(text: string, options?: WorkerStreamOptions): AsyncGenerator<Float32Array, void, undefined>;
  /**
   * Speaks aloud. A string is one utterance; pieces of text that are still arriving (a language
   * model's tokens) are spoken clause by clause, Markdown read as words.
   */
  say(text: string | Iterable<string> | AsyncIterable<string>, options?: SayOptions): Playback;
  /** Stops the worker. */
  free(): void;
}

/** Starts a worker, loads the engine in it, and returns its voice. */
export async function createWorkerVoice(options: WorkerVoiceOptions = {}): Promise<AsyncVoice> {
  const { worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }), ...rest } =
    options;
  const send = (request: ToWorker, transfer: Transferable[] = []) => worker.postMessage(request, transfer);
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

    say(text, options = {}) {
      check();
      const id = ++next;
      const { context, destination, signal, clauses: cutting, ...speak } = options;
      let refuse: (error: Error) => void = () => {};
      const failure = new Promise<never>((_, reject) => {
        refuse = reject;
      });
      listeners.set(id, (reply) => {
        if (reply.type === "error") refuse(new Error(reply.message));
      });
      const playOptions: PlayOptions = {};
      if (context) playOptions.context = context;
      if (destination) playOptions.destination = destination;
      if (signal) playOptions.signal = signal;
      const playback = playThrough(
        sampleRate,
        playOptions,
        async (port, stopped) => {
          if (stopped()) return;
          send({ type: "say", id, options: speak, port }, [port]);
          try {
            const pieces = typeof text === "string" ? [text] : clauses(text, cutting);
            for await (const clause of pieces) {
              if (stopped()) return;
              send({ type: "clause", id, text: clause });
            }
          } finally {
            // A stop that came before the worker knew this request is repeated here.
            send({ type: stopped() ? "cancel" : "said", id });
          }
        },
        () => send({ type: "cancel", id }),
      );
      const done = Promise.race([playback.done, failure]).finally(() => listeners.delete(id));
      return { queued: playback.queued, done, stop: playback.stop };
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
