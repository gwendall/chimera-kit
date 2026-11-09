/**
 * Runs inside an AudioWorkletProcessor: the held, played voice and its beatbox, rendered a
 * render quantum at a time right on the audio thread. Not meant to be imported from the page;
 * `intone/live` (`live.ts`) is the module `context.audioWorklet.addModule` is given, and talks to
 * this one over its `port`.
 *
 * The AudioWorklet spec always loads this file as an ES module, so it can `import` normally; the
 * ambient declarations below fill in the worklet globals TypeScript's DOM lib doesn't carry.
 */
import {
  type ChimeraLiveEngine,
  type FromLive,
  instantiateLive,
  type ToLive,
} from "./engines/chimera-live.js";

declare global {
  class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor(options?: AudioWorkletNodeOptions);
  }
  function registerProcessor(
    name: string,
    processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
  ): void;
  const sampleRate: number;
}

/** Render quanta between two telemetry snapshots: about 47 Hz at the usual 128-sample quantum. */
const TELEMETRY_EVERY = 8;

class LiveProcessor extends AudioWorkletProcessor {
  private engine: ChimeraLiveEngine | undefined;
  private pending: ToLive[] = [];
  private freed = false;
  private tick = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = ({ data }: MessageEvent<ToLive>) => this.handle(data);
    const given = (options?.processorOptions ?? {}) as { module?: WebAssembly.Module; bytes?: Uint8Array };
    void this.start(given.module, given.bytes);
  }

  private async start(module: WebAssembly.Module | undefined, bytes: Uint8Array | undefined): Promise<void> {
    try {
      const compiled = module ?? (await WebAssembly.compile(bytes as BufferSource));
      const engine = await instantiateLive(compiled, sampleRate);
      if (this.freed) {
        engine.free();
        return;
      }
      this.engine = engine;
      const queued = this.pending;
      this.pending = [];
      for (const message of queued) this.apply(engine, message);
      this.port.postMessage({ type: "ready" } satisfies FromLive);
    } catch (error) {
      this.port.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies FromLive);
    }
  }

  private handle(message: ToLive): void {
    if (message.type === "free") {
      this.freed = true;
      this.engine?.free();
      this.engine = undefined;
      return;
    }
    if (!this.engine) {
      this.pending.push(message);
      return;
    }
    this.apply(this.engine, message);
  }

  /** Applies one message; a rejected call (invalid input) is reported back and leaves the
   * engine exactly as it was, since each `ChimeraLiveEngine` setter validates before mutating. */
  private apply(engine: ChimeraLiveEngine, message: ToLive): void {
    try {
      switch (message.type) {
        case "setBody":
          engine.setBody(message.body);
          return;
        case "shape":
          engine.shape(message.values, message.options);
          return;
        case "source":
          engine.source(message.values);
          return;
        case "vowel":
          engine.vowel(message.ipa);
          return;
        case "noteOn":
          engine.noteOn(message.midi, message.velocity);
          return;
        case "noteOff":
          engine.noteOff();
          return;
        case "bend":
          engine.bend(message.midi);
          return;
        case "beatHit":
          engine.beatHit(message.hit);
          return;
        case "beatSteps":
          engine.beatSteps(message.pattern);
          return;
        case "beatTempo":
          engine.beatTempo(message.tempo);
          return;
        case "beatPlaying":
          engine.beatPlaying(message.playing);
          return;
      }
    } catch (error) {
      this.port.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        request: message,
      } satisfies FromLive);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.freed) return false;
    const out = outputs[0]?.[0];
    if (!out) return true;
    if (!this.engine) {
      out.fill(0);
      return true;
    }
    out.set(this.engine.render(out.length));
    this.tick++;
    if (this.tick >= TELEMETRY_EVERY) {
      this.tick = 0;
      this.port.postMessage({ type: "telemetry", data: this.engine.telemetry() } satisfies FromLive);
    }
    return true;
  }
}

registerProcessor("intone-live", LiveProcessor);
