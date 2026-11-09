/**
 * The Worker side of `createWorkerVoice`: one voice, its requests served one after the other, and
 * samples sent back as they are computed. Not meant to be imported.
 */
import { type CreateVoiceOptions, createVoice } from "./index.js";
import type { StreamOptions, Voice } from "./voice.js";

export type ToWorker =
  | { type: "open"; options: CreateVoiceOptions }
  | { type: "render" | "stream"; id: number; text: string; options: StreamOptions }
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

let voice: Voice | undefined;
const waiting = new Set<number>();
const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

scope.onmessage = ({ data }) => {
  if (data.type === "cancel") {
    if (waiting.has(data.id)) cancelled.add(data.id);
    return;
  }
  if (data.type === "render" || data.type === "stream") waiting.add(data.id);
  queue = queue.then(() => serve(data));
};

async function serve(request: ToWorker): Promise<void> {
  switch (request.type) {
    case "open":
      try {
        voice = await createVoice(request.options);
        post({ type: "ready", sampleRate: voice.sampleRate });
      } catch (error) {
        post({ type: "error", message: message(error) });
      }
      return;
    case "render":
    case "stream": {
      const { id } = request;
      try {
        if (cancelled.has(id)) return;
        if (!voice) throw new Error("intone: the worker has no voice");
        if (request.type === "render") {
          const { audio } = voice.render(request.text, request.options);
          post({ type: "rendered", id, audio }, [audio.buffer]);
          return;
        }
        let since = performance.now();
        for (const chunk of voice.stream(request.text, request.options)) {
          post({ type: "chunk", id, chunk }, [chunk.buffer]);
          if (performance.now() - since > SLICE_MS) {
            await breathe();
            if (cancelled.has(id)) return;
            since = performance.now();
          }
        }
        post({ type: "end", id });
      } catch (error) {
        post({ type: "error", id, message: message(error) });
      } finally {
        waiting.delete(id);
        cancelled.delete(id);
      }
      return;
    }
    case "free":
      voice?.free();
      scope.close();
      return;
    case "cancel":
      return;
  }
}
