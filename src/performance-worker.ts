/** Pull-based synthesis: no autonomous render loop and no unbounded output queue. */
import { createPerformanceRenderer, type PerformanceRenderer } from "./performance.js";
import type { PerformanceBlock, PerformancePart } from "./performance-pool.js";

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};
const voices = new Map<string, PerformanceRenderer>();
let queue = Promise.resolve();
self.onmessage = (event) => {
  // Initialization can await wasm; serialize later requests behind it on this Worker only.
  queue = queue.then(async () => {
    const m = event.data;
    try {
      if (m.type === "init") {
        for (const p of m.parts as PerformancePart[]) {
          if (voices.has(p.id)) throw new Error("duplicate performance voice");
          voices.set(p.id, await createPerformanceRenderer(p.performance, { module: m.module }));
        }
        self.postMessage({ request: m.request });
      } else if (m.type === "seek") {
        const voice = voices.get(m.id);
        if (!voice) throw new Error("unknown performance voice");
        voice.restore(m.sample);
        let yielded = performance.now();
        while (voice.position < m.sample) {
          voice.next(Math.min(800 - (voice.position % 800), m.sample - voice.position));
          if (voice.position % 800 === 0) voice.telemetry();
          if (voice.position % 240000 === 0) voice.checkpoint();
          if (performance.now() - yielded > 8) {
            self.postMessage({ request: m.request, progress: voice.position });
            await new Promise((resolve) => setTimeout(resolve, 0));
            yielded = performance.now();
          }
        }
        self.postMessage({
          request: m.request,
          result: {
            start: voice.position,
            end: voice.position,
            audio: new Float32Array(),
            frames: [{ sample: voice.position, state: voice.telemetry() }],
          },
        });
      } else if (m.type === "read") {
        const voice = voices.get(m.id);
        if (!voice) throw new Error("unknown performance voice");
        const start = voice.position;
        const audio = new Float32Array(Math.min(m.samples, voice.samples - start));
        const result: PerformanceBlock = {
          start,
          end: start,
          audio,
          frames: start === 0 ? [{ sample: 0, state: voice.telemetry() }] : [],
        };
        while (voice.position < start + audio.length) {
          const at = voice.position;
          const toFrame = 800 - (at % 800);
          const chunk = voice.next(Math.min(toFrame, audio.length - (at - start)));
          if (!chunk) break;
          audio.set(chunk, at - start);
          if (voice.position % 800 === 0)
            result.frames.push({ sample: voice.position, state: voice.telemetry() });
          if (voice.position % 240000 === 0) voice.checkpoint();
        }
        result.end = voice.position;
        const transfer: Transferable[] = [audio.buffer];
        for (const f of result.frames)
          for (const v of Object.values(f.state))
            if (v instanceof Float32Array) transfer.push(v.buffer as ArrayBuffer);
        self.postMessage({ request: m.request, result }, transfer);
      } else throw new Error("unknown performance worker request");
    } catch (error) {
      self.postMessage({ request: m.request, error: error instanceof Error ? error.message : String(error) });
    }
  });
};
