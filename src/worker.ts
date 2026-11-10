/**
 * The Worker side of `createWorkerVoice`: one voice, its requests served one after the other, and
 * samples sent as they are computed, back to the page or straight to the audio thread. Not meant
 * to be imported.
 */
import { deliver } from "./delivery.js";
import { createVoice } from "./index.js";
import type { Score, Song } from "./layers.js";
import { pacedClause } from "./pace.js";
import type { StreamOptions, Voice } from "./voice.js";
import type { DeliveryOptions, WorkerStreamOptions, WorkerVoiceOptions } from "./worker-voice.js";

export type ToWorker =
  | { type: "open"; options: Omit<WorkerVoiceOptions, "worker"> }
  | { type: "render" | "stream"; id: number; text: string | Song | Score; options: WorkerStreamOptions }
  /** Starts speaking into `port`, an AudioWorklet player's, the clauses that follow. */
  | { type: "say"; id: number; options: WorkerStreamOptions; port: MessagePort }
  | { type: "clause"; id: number; text: string | Song }
  /** No more clauses for this `say`. */
  | { type: "said"; id: number }
  | { type: "cancel"; id: number }
  | { type: "free" };

export type FromWorker =
  | { type: "ready"; sampleRate: number }
  | { type: "chunk"; id: number; chunk: Float32Array }
  | { type: "end"; id: number }
  | { type: "rendered"; id: number; audio: Float32Array }
  | { type: "error"; id?: number; message: string };

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => scope.postMessage(message, transfer);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Milliseconds of work between two looks at the message queue, where cancels wait. */
const SLICE_MS = 8;
const channel = new MessageChannel();
/** Lets queued messages run. Faster than setTimeout, which browsers clamp to 4 ms. */
const breathe = () =>
  new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(0);
  });

/** A request that has arrived and not finished: its clauses so far, and whether it was cancelled. */
interface Pending {
  clauses: (string | Song | Score)[];
  said: boolean;
  cancelled: boolean;
  wake?: (() => void) | undefined;
}

let voice: Voice | undefined;
/** The voice's own delivery, which each request's may replace. */
let delivering: DeliveryOptions = {};

/**
 * A request's options for the voice: its delivery, or the voice's, as a style. A song takes only
 * its call's, as on the page: the voice's own would slow and detune the melody.
 */
function voiceOptions(options: WorkerStreamOptions, song = false): StreamOptions {
  const own = song ? {} : delivering;
  const { delivery = own.delivery, intensity = own.intensity, ...rest } = options;
  return delivery === undefined ? rest : { ...rest, style: deliver(delivery, intensity) };
}
const pending = new Map<number, Pending>();
let queue: Promise<void> = Promise.resolve();

scope.onmessage = ({ data }) => {
  if (data.type === "cancel" || data.type === "clause" || data.type === "said") {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "cancel") request.cancelled = true;
    else if (data.type === "said") request.said = true;
    else request.clauses.push(data.text);
    request.wake?.();
    return;
  }
  if (data.type === "render" || data.type === "stream" || data.type === "say") {
    const say = data.type === "say";
    pending.set(data.id, { clauses: say ? [] : [data.text], said: !say, cancelled: false });
  }
  queue = queue.then(() => serve(data));
};

async function serve(request: ToWorker): Promise<void> {
  switch (request.type) {
    case "open":
      try {
        const { delivery, intensity, ...rest } = request.options;
        delivering = {};
        if (delivery !== undefined) delivering.delivery = delivery;
        if (intensity !== undefined) delivering.intensity = intensity;
        voice = await createVoice(rest);
        post({ type: "ready", sampleRate: voice.sampleRate });
      } catch (error) {
        post({ type: "error", message: message(error) });
      }
      return;
    case "render":
    case "stream":
    case "say": {
      const { id } = request;
      const state = pending.get(id) as Pending;
      const port = request.type === "say" ? request.port : undefined;
      try {
        if (!voice) throw new Error("chimera-kit: the worker has no voice");
        if (request.type === "render") {
          if (state.cancelled) return;
          const { text, options } = request;
          const { audio } = voice.render(text, voiceOptions(options, typeof text !== "string"));
          post({ type: "rendered", id, audio }, [audio.buffer]);
          return;
        }
        const send = port
          ? (chunk: Float32Array) => port.postMessage(chunk, [chunk.buffer])
          : (chunk: Float32Array) => post({ type: "chunk", id, chunk }, [chunk.buffer]);
        if (await speak(voice, state, request.options, send, request.type === "say")) {
          if (port) port.postMessage("end");
          else post({ type: "end", id });
        }
      } catch (error) {
        port?.postMessage("stop");
        post({ type: "error", id, message: message(error) });
      } finally {
        pending.delete(id);
        port?.close();
      }
      return;
    }
    case "free":
      voice?.free();
      scope.close();
      return;
    default:
      return;
  }
}

/** Speaks a request's clauses (or its song) as they come. False when it was cancelled. */
async function speak(
  voice: Voice,
  state: Pending,
  options: WorkerStreamOptions,
  send: (chunk: Float32Array) => void,
  paced: boolean,
): Promise<boolean> {
  let since = performance.now();
  for (;;) {
    if (state.cancelled) return false;
    const text = state.clauses.shift();
    if (text === undefined) {
      if (state.said) return true;
      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
      state.wake = undefined;
      since = performance.now();
      continue;
    }
    // `say` gives each clause the pause its last mark asks; `stream`, a song and a score are the
    // engine's samples as they are.
    const chunks =
      typeof text !== "string"
        ? voice.stream(text, voiceOptions(options, true))
        : paced
          ? pacedClause(voice, text, voiceOptions(options))
          : voice.stream(text, voiceOptions(options));
    for (const chunk of chunks) {
      send(chunk);
      if (performance.now() - since > SLICE_MS) {
        await breathe();
        if (state.cancelled) return false;
        since = performance.now();
      }
    }
  }
}
