/** Parallel physical voices, one audible clock, bounded synthesis and independently routed outputs. */

import type { LiveTelemetry } from "./performance.js";
import {
  createPerformancePool,
  type PerformanceBlock,
  type PerformanceFrame,
  type PerformancePart,
  type PerformancePool,
  type PerformancePoolOptions,
} from "./performance-pool.js";

export interface EnsemblePart extends PerformancePart {
  gain?: number;
}
export interface EnsembleOptions extends PerformancePoolOptions {
  context?: AudioContext;
  destination?: AudioNode;
  /** Seconds generated ahead of the listener, in [0.5, 8]. Default 2. */
  ahead?: number;
}
export interface EnsembleState {
  time: number;
  duration: number;
  playing: boolean;
  preparing: boolean;
  epoch: number;
  workers: number;
  underruns: number;
  bufferedSeconds: number;
  error: string | null;
}
interface PartState {
  id: string;
  output: GainNode;
  blocks: PerformanceBlock[];
  frames: PerformanceFrame[];
  end: number;
  scheduled: number;
}

export interface Ensemble {
  readonly context: AudioContext;
  readonly outputs: ReadonlyMap<string, GainNode>;
  readonly duration: number;
  readonly epoch: number;
  readonly isPlaying: boolean;
  readonly state: EnsembleState;
  subscribe(listener: () => void): () => void;
  time(): number;
  telemetry(id: string, time?: number): LiveTelemetry | undefined;
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<void>;
  free(): void;
}

class EnsemblePlayer implements Ensemble {
  readonly outputs = new Map<string, GainNode>();
  readonly duration: number;
  epoch = 0;
  private readonly parts: PartState[];
  private readonly listeners = new Set<() => void>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private offset = 0;
  private origin = 0;
  private startedAt = 0;
  private playing = false;
  private preparing = false;
  private freed = false;
  private generation = 0;
  private underruns = 0;
  private error: string | null = null;
  private filling: Promise<void> | null = null;
  private seeking: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly stateChange: () => void;
  private wasRunning = false;

  /** Use createEnsemble so initialization failures release both Workers and the owned context. */
  constructor(
    readonly context: AudioContext,
    private readonly pool: PerformancePool,
    parts: EnsemblePart[],
    private readonly ahead: number,
    destination: AudioNode,
    private readonly ownsContext: boolean,
  ) {
    this.duration = parts[0]?.performance.duration ?? 0;
    this.parts = parts.map((p) => {
      const output = context.createGain();
      output.gain.value = p.gain ?? 1;
      output.connect(destination);
      this.outputs.set(p.id, output);
      return { id: p.id, output, blocks: [], frames: [], end: 0, scheduled: 0 };
    });
    this.stateChange = () => {
      if (this.wasRunning && context.state !== "running") this.pause();
      this.wasRunning = context.state === "running";
    };
    context.addEventListener("statechange", this.stateChange);
    this.timer = setInterval(() => {
      if (!this.playing || this.freed) return;
      if (this.time() >= this.duration) {
        this.pause();
        this.offset = this.duration;
        this.emit();
        return;
      }
      void this.fill(this.time() + this.ahead).catch((e) => this.fail(e));
    }, 40);
  }

  get isPlaying(): boolean {
    return this.playing;
  }
  get state(): EnsembleState {
    return {
      time: this.time(),
      duration: this.duration,
      playing: this.playing,
      preparing: this.preparing,
      epoch: this.epoch,
      workers: this.pool.workers,
      underruns: this.underruns,
      bufferedSeconds: Math.max(0, Math.min(...this.parts.map((p) => p.end / 48000)) - this.time()),
      error: this.error,
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const f of this.listeners) f();
  }
  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.pause();
    this.emit();
  }

  /** Device output time when available, so physical snapshots follow the samples being heard. */
  time(): number {
    if (!this.playing) return this.offset;
    const stamp = this.context.getOutputTimestamp?.().contextTime ?? 0;
    const audioTime =
      stamp > 0
        ? Math.min(this.context.currentTime, stamp)
        : this.context.currentTime - (this.context.outputLatency || this.context.baseLatency || 0);
    return Math.max(this.offset, Math.min(this.duration, this.origin / 48000 + audioTime - this.startedAt));
  }

  telemetry(id: string, time = this.time()): LiveTelemetry | undefined {
    const part = this.parts.find((p) => p.id === id);
    const sample = Math.round(time * 48000);
    if (!part) return undefined;
    for (let i = part.frames.length - 1; i >= 0; i--) {
      const frame = part.frames[i];
      if (frame && frame.sample <= sample) return frame.state;
    }
    return undefined;
  }

  private schedule(part: PartState, block: PerformanceBlock): void {
    if (!this.playing || block.end <= Math.max(this.origin, part.scheduled)) return;
    let from = Math.max(block.start, this.origin, part.scheduled);
    const desired = this.startedAt + (from - this.origin) / 48000;
    if (desired < this.context.currentTime) {
      this.underruns++;
      from += Math.ceil((this.context.currentTime - desired) * 48000);
    }
    part.scheduled = block.end;
    if (from >= block.end) return;
    const buffer = this.context.createBuffer(1, block.audio.length, 48000);
    buffer.copyToChannel(block.audio as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(part.output);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };
    this.sources.add(source);
    source.start(
      Math.max(this.context.currentTime, this.startedAt + (from - this.origin) / 48000),
      (from - block.start) / 48000,
    );
  }

  /** Bounded to the requested horizon and one outstanding read per part. Pauses retain recent chunks. */
  private async fill(through: number): Promise<void> {
    if (this.filling) {
      await this.filling;
      return;
    }
    const end = Math.min(Math.round(this.duration * 48000), Math.ceil(through * 48000));
    this.filling = (async () => {
      while (!this.freed && this.parts.some((p) => p.end < end)) {
        await Promise.all(
          this.parts
            .filter((p) => p.end < end)
            .map(async (p) => {
              const block = await this.pool.read(p.id, Math.min(4800, end - p.end));
              if (this.freed) return;
              if (block.end <= p.end) throw new Error(`ensemble: ${p.id} ended before the shared duration`);
              p.blocks.push(block);
              p.frames.push(...block.frames);
              p.end = block.end;
              this.schedule(p, block);
              const keep = Math.max(0, Math.floor((this.time() - 2) * 48000));
              while (p.blocks.length > 1 && (p.blocks[0]?.end ?? Infinity) < keep) p.blocks.shift();
              while (p.frames.length > 1 && (p.frames[1]?.sample ?? Infinity) < keep) p.frames.shift();
            }),
        );
      }
    })();
    try {
      await this.filling;
    } finally {
      this.filling = null;
    }
  }

  /** Call from the user gesture: resume is invoked before any asynchronous preparation. */
  async play(): Promise<void> {
    if (this.freed) throw new Error("ensemble: freed");
    if (this.playing) return;
    const resumed = this.context.resume();
    const generation = this.generation;
    this.preparing = true;
    this.emit();
    try {
      await resumed;
      await this.seeking;
      if (generation !== this.generation || this.freed) return;
      if (this.offset >= this.duration) {
        await this.seek(0);
        return this.play();
      }
      await this.fill(this.offset + Math.min(this.ahead, 0.8));
      if (generation !== this.generation || this.freed) return;
      this.origin = Math.round(this.offset * 48000);
      this.startedAt = this.context.currentTime + 0.08;
      this.playing = true;
      this.epoch++;
      for (const p of this.parts) {
        p.scheduled = this.origin;
        for (const block of p.blocks) this.schedule(p, block);
      }
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      this.preparing = false;
      this.emit();
    }
  }

  pause(): void {
    this.offset = this.time();
    this.playing = false;
    this.generation++;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.emit();
  }

  async seek(time: number): Promise<void> {
    if (this.freed || !Number.isFinite(time)) throw new Error("ensemble: invalid seek");
    const resume = this.playing;
    this.pause();
    const generation = this.generation;
    this.offset = Math.max(0, Math.min(this.duration, time));
    const sample = Math.round(this.offset * 48000);
    this.epoch++;
    this.preparing = true;
    this.emit();
    const previous = this.seeking;
    this.seeking = (async () => {
      await previous;
      if (this.filling) await this.filling;
      if (generation !== this.generation || this.freed) return;
      await Promise.all(
        this.parts.map(async (p) => {
          const frame = await this.pool.seek(p.id, sample);
          p.blocks = [];
          p.frames = [frame];
          p.end = sample;
          p.scheduled = sample;
        }),
      );
    })();
    try {
      await this.seeking;
      if (generation !== this.generation || this.freed) return;
      this.preparing = false;
      this.emit();
      if (resume) await this.play();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  free(): void {
    if (this.freed) return;
    this.pause();
    this.freed = true;
    clearInterval(this.timer);
    this.context.removeEventListener("statechange", this.stateChange);
    this.pool.free();
    for (const p of this.parts) p.output.disconnect();
    this.listeners.clear();
    if (this.ownsContext) void this.context.close();
  }
}

export async function createEnsemble(
  parts: EnsemblePart[],
  options: EnsembleOptions = {},
): Promise<Ensemble> {
  if (!parts.length || parts.some((p) => p.performance.duration !== parts[0]?.performance.duration))
    throw new Error("ensemble: parts need one shared duration");
  if (parts.some((p) => p.gain !== undefined && (!Number.isFinite(p.gain) || p.gain < 0 || p.gain > 4)))
    throw new Error("ensemble: gain must be 0..4");
  const ahead = options.ahead ?? 2;
  if (!Number.isFinite(ahead) || ahead < 0.5 || ahead > 8)
    throw new Error("ensemble: ahead must be 0.5..8 seconds");
  const context = options.context ?? new AudioContext({ latencyHint: "playback" });
  let pool: PerformancePool | undefined;
  try {
    pool = await createPerformancePool(parts, options);
    return new EnsemblePlayer(
      context,
      pool,
      parts,
      ahead,
      options.destination ?? context.destination,
      !options.context,
    );
  } catch (error) {
    pool?.free();
    if (!options.context) await context.close();
    throw error;
  }
}
