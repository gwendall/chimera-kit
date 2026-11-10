// One voice, one audio graph and one clock for the whole page: every demo speaks through here, and
// the monitor on the right measures and draws whatever is sounding now.

import { type Creatures, loadCreatures } from "./chimera-kit/creatures.js";
import {
  type AsyncVoice,
  type Body,
  createVoice,
  createWorkerVoice,
  deliver,
  type Mood,
  type Playback,
  play,
  type Score,
  type Song,
  speech,
  unlockAudio,
  type Voice,
} from "./chimera-kit/index.js";
import { type Scene, scene as sceneTurns, type Turn } from "./crowd";
import { SPECTRUM_SIZE, spectrumColumn } from "./spectrum";

export interface Snapshot {
  ready: boolean;
  speaking: boolean;
  /** Milliseconds from the call to the first sample computed, for the last thing spoken. */
  firstSampleMs: number | null;
  label: string;
  /** Milliseconds from asking for the engine to being able to speak. */
  engineLoadMs: number | null;
  /** Seconds of voice computed per second of work, for the last thing spoken. */
  speedX: number | null;
  /** Voices sounding right now. */
  voices: number;
  /** The last first-sample times, oldest first. */
  history: number[];
  /** Network requests the page made while anything was speaking. */
  requests: number;
  /** What this device's own audio path adds after the sample is computed. */
  deviceMs: number | null;
}

export interface CrowdReport {
  voices: number;
  running: boolean;
  spoken: number;
  firstMs: number[];
  /** Seconds of voice the audio thread had to go without. */
  gapSeconds: number;
  /** Seconds of voice computed so far, summed over every voice. */
  audioSeconds: number;
  errors: number;
  peak: number;
}

export interface Reading {
  mode: "live" | "ghost" | "scope" | "idle";
  /** The airway at this instant, in the layout of `StreamOptions.airway`. */
  frame: Float32Array | null;
  /** Every airway state passed since the last read, for measuring what a single frame would miss. */
  recent: Float32Array[];
  /** Seconds into what is sounding. */
  t: number;
  score: Score | null;
}

interface Sounding {
  id: number;
  kind: "voice" | "creature";
  score: Score | null;
  frames: Float32Array[];
  times: number[];
  cursor: number;
  /** The audio clock when the first sample reaches the speakers; null until it has been computed. */
  startedAt: number | null;
}

interface PlaybackOptions {
  signal?: AbortSignal;
  /** A clock in seconds, started when samples reach playback, after any preparation. */
  onStart?: (elapsed: () => number) => void;
}

interface SpeakOptions extends PlaybackOptions {
  body?: Body;
  style?: Mood;
  intensity?: number;
  label?: string;
  f0?: number;
  rate?: number;
  accent?: number;
  onFirstSample?: (ms: number) => void;
}

const GHOST_LINE = "Every syllable here does exactly what it is told.";
const SAMPLE_RATE = 48_000;
const MIN_DB = -92;
const MAX_DB = -18;
const HISTORY = 64;
/** Seconds of a crowd's voice held back before it starts. */
const CROWD_CUSHION = 0.6;

class Studio {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = {
    ready: false,
    speaking: false,
    firstSampleMs: null,
    label: "",
    engineLoadMs: null,
    speedX: null,
    voices: 0,
    history: [],
    requests: 0,
    deviceMs: null,
  };
  private voice: Voice | null = null;
  private loading: Promise<Voice> | null = null;
  private zoo: Promise<Creatures> | null = null;
  private context: AudioContext | null = null;
  private output: AnalyserNode | null = null;
  private playback: Playback | null = null;
  private sounding: Sounding | null = null;
  private ghost: {
    frames: Float32Array[];
    times: number[];
    score: Score;
    duration: number | null;
    cursor: number;
    columns: Uint8Array[];
  } | null = null;
  private pool: Promise<AsyncVoice>[] = [];
  private crowdRun: AbortController | null = null;
  private serial = 0;
  /** The last stretch of time something was sounding: the network counter looks at this window. */
  private spokeFrom = Number.POSITIVE_INFINITY;
  private spokeUntil = Number.POSITIVE_INFINITY;
  /** Workers asked for while a voice was sounding, started as soon as it ends. */
  private warmLater = 0;
  /** A creature's picture stays up for a moment after its call ends. */
  private scopeUntil = 0;
  /** The monitor draws the throat itself only while "How it works" is on screen. */
  showThroat = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<Snapshot>) {
    const was = this.snapshot.speaking;
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.snapshot.speaking !== was) {
      if (this.snapshot.speaking) {
        this.spokeFrom = performance.now();
        this.spokeUntil = Number.POSITIVE_INFINITY;
      } else {
        this.spokeUntil = performance.now();
        if (this.warmLater) {
          this.spawn(this.warmLater);
          this.warmLater = 0;
        }
      }
    }
    for (const listener of this.listeners) listener();
  }

  /** Starts loading the engine; safe to call any number of times. */
  load(): Promise<Voice> {
    if (this.loading) return this.loading;
    const asked = performance.now();
    this.loading = createVoice({ body: "female" }).then((voice) => {
      this.voice = voice;
      this.set({ ready: true, engineLoadMs: performance.now() - asked });
      this.countRequests();
      if (this.ghostWanted) void this.buildGhost(voice);
      return voice;
    });
    return this.loading;
  }

  /** From here on, anything fetched while a voice is sounding is counted, and shown. */
  private countRequests() {
    if (typeof PerformanceObserver === "undefined") return;
    new PerformanceObserver((list) => {
      const during = list
        .getEntries()
        .filter(({ startTime }) => startTime >= this.spokeFrom && startTime <= this.spokeUntil).length;
      if (during) this.set({ requests: this.snapshot.requests + during });
    }).observe({ type: "resource" });
  }

  private ghostWanted = false;

  /**
   * The throat drawing asks for the silent reading when it first shows. Computing it at load cost
   * a phone seconds of main thread for a drawing most visitors never scroll to.
   */
  wantGhost() {
    if (this.ghostWanted) return;
    this.ghostWanted = true;
    if (this.voice) void this.buildGhost(this.voice);
  }

  /** A real, silent reading, computed in small slices, that keeps the throat moving before any click. */
  private async buildGhost(voice: Voice) {
    const score = voice.plan(GHOST_LINE);
    const frames: Float32Array[] = [];
    const times: number[] = [];
    let samples = 0;
    const columns: Uint8Array[] = [];
    const ring = new Float32Array(SPECTRUM_SIZE);
    const ghost = { frames, times, score, duration: null as number | null, cursor: 0, columns };
    this.ghost = ghost;
    const chunks = voice.stream(score, {
      chunkSize: 480,
      airway: (state) => {
        frames.push(state);
        times.push(samples / voice.sampleRate);
      },
    });
    for (;;) {
      const sliceStart = performance.now();
      while (performance.now() - sliceStart < 10) {
        const next = chunks.next();
        if (next.done) {
          ghost.duration = samples / voice.sampleRate;
          return;
        }
        samples += next.value.length;
        ring.copyWithin(0, next.value.length);
        ring.set(next.value, SPECTRUM_SIZE - next.value.length);
        columns.push(spectrumColumn(ring, MIN_DB, MAX_DB));
      }
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
  }

  /** Must first run inside a click or a key press: browsers keep audio suspended until then. */
  private audio(): { context: AudioContext; output: AnalyserNode } {
    if (!this.context || !this.output) {
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
      this.output = this.context.createAnalyser();
      this.output.fftSize = 4096;
      this.output.smoothingTimeConstant = 0;
      this.output.minDecibels = MIN_DB;
      this.output.maxDecibels = MAX_DB;
      this.output.connect(this.context.destination);
    }
    unlockAudio(this.context);
    return { context: this.context, output: this.output };
  }

  /** The page's audio graph, for a demo that plays through something other than this voice. */
  route(): { context: AudioContext; output: AnalyserNode } {
    return this.audio();
  }

  /**
   * Something played through `route()` is sounding: the monitor shows its spectrum for the next
   * `ms`. Called again while it lasts.
   */
  hold(label: string, ms = 900) {
    this.scopeUntil = performance.now() + ms;
    if (this.snapshot.label !== label) this.set({ label });
  }

  /** A first sample measured outside this class, shown on the monitor all the same. */
  note(ms: number) {
    this.set({ firstSampleMs: ms });
  }

  /** Called on every tap until sound is allowed, so a demo may await something before it speaks. */
  unlock(): boolean {
    return this.audio().context.state === "running";
  }

  get analyser(): AnalyserNode | null {
    return this.output;
  }

  /** The silent reading's spectrum at a moment of it, computed like the analyser's. */
  ghostColumn(t: number): Uint8Array | null {
    const columns = this.ghost?.columns;
    if (!columns?.length) return null;
    return columns[Math.min(columns.length - 1, Math.floor(t * 100))] ?? null;
  }

  stop() {
    this.serial++;
    this.playback?.stop();
    this.playback = null;
    this.sounding = null;
    this.crowdRun?.abort();
    this.crowdRun = null;
    this.set({ speaking: false, voices: 0 });
  }

  private begin(kind: Sounding["kind"], score: Score | null, label: string): Sounding {
    this.stop();
    this.scopeUntil = 0;
    const sounding: Sounding = {
      id: this.serial,
      kind,
      score,
      frames: [],
      times: [],
      cursor: 0,
      startedAt: null,
    };
    this.sounding = sounding;
    this.set({ speaking: true, label, voices: 1 });
    return sounding;
  }

  private watch(sounding: Sounding, playback: Playback) {
    this.playback = playback;
    void playback.done.then(() => {
      if (this.sounding?.id !== sounding.id) return;
      if (sounding.kind === "creature") this.scopeUntil = performance.now() + 1600;
      this.sounding = null;
      this.playback = null;
      this.set({ speaking: false, voices: 0 });
    });
  }

  /** What a first sample cost, shown everywhere at once. */
  private measured(ms: number, context: AudioContext, keep: boolean) {
    this.set({
      firstSampleMs: ms,
      deviceMs: (context.baseLatency + (context.outputLatency || 0)) * 1000,
      ...(keep ? { history: [...this.snapshot.history.slice(1 - HISTORY), ms] } : {}),
    });
  }

  /** Measures the source as it computes: when its first sample left, and how much faster than real time. */
  private *timed(
    chunks: Iterable<Float32Array>,
    sounding: Sounding,
    context: AudioContext,
    calledAt: number,
    sampleRate: number,
    onSample: (n: number) => void,
    onFirstSample?: (ms: number) => void,
  ) {
    const source = chunks[Symbol.iterator]();
    let samples = 0;
    let busy = 0;
    let shown = 0;
    const show = () => {
      if (busy > 0) this.set({ speedX: ((samples / sampleRate) * 1000) / busy });
    };
    try {
      for (;;) {
        const before = performance.now();
        const next = source.next();
        const after = performance.now();
        if (next.done) return;
        busy += after - before;
        if (sounding.startedAt === null) {
          sounding.startedAt = context.currentTime + context.baseLatency + (context.outputLatency || 0);
          this.measured(after - calledAt, context, true);
          onFirstSample?.(after - calledAt);
        }
        samples += next.value.length;
        onSample(samples);
        if (after - shown > 200) {
          shown = after;
          show();
        }
        yield next.value;
      }
    } finally {
      show();
      source.return?.();
    }
  }

  /** Text, a song or a score, spoken at once. Text and songs are planned first, so the page can draw them. */
  async speak(input: string | Song | Score, options: SpeakOptions = {}) {
    const { context, output } = this.audio();
    const voice = this.voice ?? (await this.load());
    options.signal?.throwIfAborted();
    const calledAt = performance.now();
    const { body, style, intensity, label, f0, rate, accent, onFirstSample } = options;
    const voiced = {
      ...(body === undefined ? {} : { body }),
      ...(style === undefined ? {} : { style: deliver(style, intensity ?? 1) }),
      ...(f0 === undefined ? {} : { f0 }),
      ...(rate === undefined ? {} : { rate }),
      ...(accent === undefined ? {} : { accent }),
    };
    const score = typeof input === "string" || "notes" in input ? voice.plan(input as string, voiced) : input;
    const sounding = this.begin("voice", score, label ?? "");
    let samples = 0;
    const chunks = voice.stream(score, {
      ...(body === undefined ? {} : { body }),
      airway: (state) => this.record(sounding, state, samples / voice.sampleRate),
    });
    const timed = this.timed(
      chunks,
      sounding,
      context,
      calledAt,
      voice.sampleRate,
      (n) => {
        samples = n;
      },
      (ms) => {
        onFirstSample?.(ms);
        const startedAt = sounding.startedAt ?? context.currentTime;
        options.onStart?.(() => Math.max(0, context.currentTime - startedAt));
      },
    );
    const playback = play(timed, voice.sampleRate, {
      context,
      destination: output,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.watch(sounding, playback);
    return playback;
  }

  /** Tokens as a language model would send them, spoken clause by clause while they arrive. */
  async speakTokens(tokens: AsyncIterable<string>, options: { onFirstSample?: () => void } = {}) {
    const { context, output } = this.audio();
    const voice = this.voice ?? (await this.load());
    const sounding = this.begin("voice", null, "stream");
    let samples = 0;
    let first = true;
    const calledAt = performance.now();
    const source = speech(voice, tokens, {
      airway: (state) => this.record(sounding, state, samples / voice.sampleRate),
    });
    const stamped = async function* (studio: Studio) {
      for await (const chunk of source) {
        if (first) {
          first = false;
          sounding.startedAt = context.currentTime + context.baseLatency + (context.outputLatency || 0);
          studio.measured(performance.now() - calledAt, context, false);
          options.onFirstSample?.();
        }
        samples += chunk.length;
        yield chunk;
      }
    };
    const playback = play(stamped(this), voice.sampleRate, { context, destination: output });
    this.watch(sounding, playback);
    return playback.done;
  }

  async creatures(): Promise<Creatures> {
    this.zoo ??= loadCreatures();
    return this.zoo;
  }

  async call(id: string, call: string, params: Record<string, number> = {}) {
    const { context, output } = this.audio();
    const zoo = await this.creatures();
    const sounding = this.begin("creature", null, `${id}: ${call}`);
    const calledAt = performance.now();
    const creature = zoo.create(id, params);
    const chunks = this.timed(
      creature.stream(call, { chunkSize: 512 }),
      sounding,
      context,
      calledAt,
      zoo.sampleRate,
      () => {},
    );
    const playback = play(chunks, zoo.sampleRate, { context, destination: output });
    this.watch(sounding, playback);
    void playback.done.finally(() => creature.free());
  }

  /** Starts the workers a crowd of this size needs, one per voice: a worker speaks one thing at a time. */
  warmCrowd(voices: number): void {
    if (this.snapshot.speaking) this.warmLater = Math.max(this.warmLater, voices);
    else this.spawn(voices);
  }

  private spawn(voices: number): Promise<AsyncVoice[]> {
    while (this.pool.length < voices) this.pool.push(createWorkerVoice({ body: "female" }));
    return Promise.all(this.pool.slice(0, voices));
  }

  /** A whole scene at once: every voice a real simulation in its own worker, mixed live. */
  async crowd(name: Scene, voices: number, on: (report: CrowdReport) => void): Promise<CrowdReport> {
    const { context, output } = this.audio();
    this.stop();
    const report: CrowdReport = {
      voices,
      running: true,
      spoken: 0,
      firstMs: [],
      gapSeconds: 0,
      audioSeconds: 0,
      errors: 0,
      peak: 0,
    };
    on({ ...report });
    const pool = await this.spawn(voices);
    const run = new AbortController();
    this.crowdRun = run;
    this.scopeUntil = 0;
    // Voices add up in power: 1/sqrt(N) keeps the level, and the compressor catches the moments they line up.
    const bus = context.createGain();
    bus.gain.value = 1 / Math.sqrt(voices);
    const limiter = context.createDynamicsCompressor();
    bus.connect(limiter);
    limiter.connect(output);
    this.set({ speaking: true, label: `${voices} ${voices === 1 ? "voice" : "voices"}: ${name}`, voices: 0 });

    let active = 0;
    const speak = async (turn: Turn) => {
      const voice = pool[turn.voice] as AsyncVoice;
      const calledAt = performance.now();
      const { say, body, f0, rate, delivery, intensity } = turn;
      const sung = typeof say !== "string";
      const chunks = voice.stream(say, {
        body,
        ...(sung || f0 === undefined ? {} : { f0 }),
        ...(sung || rate === undefined ? {} : { rate }),
        ...(delivery === undefined ? {} : { delivery }),
        ...(intensity === undefined ? {} : { intensity }),
      });
      // A crowd can spare a moment at the start, and it pays for the seconds when every core is busy.
      const note = (ms: number) => this.note(ms);
      const stamped = async function* () {
        let first = true;
        let held: Float32Array[] | null = [];
        let heldSamples = 0;
        for await (const chunk of chunks) {
          if (first) {
            first = false;
            const taken = performance.now() - calledAt;
            report.firstMs.push(taken);
            note(taken);
            on({ ...report, firstMs: [...report.firstMs] });
          }
          report.audioSeconds += chunk.length / voice.sampleRate;
          if (held) {
            held.push(chunk);
            heldSamples += chunk.length;
            if (heldSamples < CROWD_CUSHION * voice.sampleRate) continue;
            yield* held;
            held = null;
            continue;
          }
          yield chunk;
        }
        if (held) yield* held;
      };
      active++;
      report.peak = Math.max(report.peak, active);
      this.set({ voices: active });
      try {
        const { underruns } = await play(stamped(), voice.sampleRate, {
          context,
          destination: bus,
          signal: run.signal,
        }).done;
        report.gapSeconds += (underruns * 128) / context.sampleRate;
        report.spoken++;
      } catch {
        report.errors++;
      }
      active--;
      if (this.crowdRun === run) this.set({ voices: active });
      on({ ...report, firstMs: [...report.firstMs] });
    };

    // Each person finishes a line before starting the next, however long the line turned out to be.
    const lines = new Map<number, Turn[]>();
    for (const turn of sceneTurns(name, voices))
      lines.set(turn.voice, [...(lines.get(turn.voice) ?? []), turn]);
    const began = performance.now();
    const until = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, ms - performance.now()));
        run.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    await Promise.all(
      [...lines.values()].map(async (own) => {
        for (const turn of own) {
          await until(began + turn.at * 1000);
          if (run.signal.aborted) return;
          await speak(turn);
        }
      }),
    );
    bus.disconnect();
    limiter.disconnect();
    if (this.crowdRun === run) {
      this.crowdRun = null;
      this.scopeUntil = performance.now() + 900;
      this.set({ speaking: false, voices: 0 });
    }
    report.running = false;
    const end = { ...report, firstMs: [...report.firstMs] };
    on(end);
    return end;
  }

  /**
   * The parts of one song together, each a real simulation in its own worker. Each holds its first
   * samples until every part has some, so that they come in on the same beat.
   */
  async parts(parts: { input: Song | Score; body: Body }[], options: PlaybackOptions = {}): Promise<void> {
    const { context, output } = this.audio();
    this.stop();
    const calledAt = performance.now();
    const run = new AbortController();
    this.crowdRun = run;
    const abort = () => run.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) run.abort();
    this.scopeUntil = 0;
    const bus = context.createGain();
    bus.gain.value = 1 / Math.sqrt(parts.length);
    const limiter = context.createDynamicsCompressor();
    bus.connect(limiter);
    limiter.connect(output);
    this.set({ speaking: true, label: `${parts.length} parts`, voices: parts.length });

    try {
      const pool = await this.spawn(parts.length);
      if (run.signal.aborted) return;
      let waiting = parts.length;
      let open: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      run.signal.addEventListener("abort", () => open());
      const note = (ms: number) => this.note(ms);
      let timed = false;

      await Promise.allSettled(
        parts.map(({ input, body }, index) => {
          const voice = pool[index] as AsyncVoice;
          const chunks = voice.stream(input, { body });
          const held = async function* () {
            const early: Float32Array[] = [];
            let samples = 0;
            let waited = false;
            const arrive = async () => {
              waited = true;
              waiting -= 1;
              if (waiting === 0) {
                const startedAt = context.currentTime + context.baseLatency + (context.outputLatency || 0);
                options.onStart?.(() => Math.max(0, context.currentTime - startedAt));
                open();
              }
              await gate;
            };
            for await (const chunk of chunks) {
              if (!timed) {
                timed = true;
                note(performance.now() - calledAt);
              }
              if (waited) {
                yield chunk;
                continue;
              }
              early.push(chunk);
              samples += chunk.length;
              if (samples < CROWD_CUSHION * voice.sampleRate) continue;
              await arrive();
              yield* early;
            }
            if (!waited) {
              await arrive();
              yield* early;
            }
          };
          return play(held(), voice.sampleRate, { context, destination: bus, signal: run.signal }).done;
        }),
      );
    } finally {
      options.signal?.removeEventListener("abort", abort);
      bus.disconnect();
      limiter.disconnect();
      if (this.crowdRun === run) {
        this.crowdRun = null;
        this.scopeUntil = performance.now() + 900;
        this.set({ speaking: false, voices: 0 });
      }
    }
  }

  private record(sounding: Sounding, state: Float32Array, t: number) {
    // Full geometry frames are larger than the old tube-only trace. Keep no hidden-view history.
    if (!this.showThroat) {
      sounding.frames.length = 0;
      sounding.times.length = 0;
      sounding.cursor = 0;
      return;
    }
    sounding.frames.push(state);
    sounding.times.push(t);
  }

  /** The sound being heard at this instant, without touching the throat's reading of the frames. */
  soundNow(): string | null {
    const now = this.sounding;
    if (!now?.score || !this.context || now.startedAt === null) return null;
    const t = this.context.currentTime - now.startedAt;
    return now.score.sounds.find((sound) => t >= sound.t0 && t < sound.t1)?.sound ?? null;
  }

  /** What the throat should show at this instant. */
  read(): Reading {
    const now = this.sounding;
    if (this.crowdRun || now?.kind === "creature" || performance.now() < this.scopeUntil) {
      return { mode: "scope", frame: null, recent: [], t: 0, score: null };
    }
    if (now && this.context && now.startedAt !== null) {
      const t = Math.max(0, this.context.currentTime - now.startedAt);
      const passedFrom = now.cursor;
      while (now.cursor + 1 < now.times.length && (now.times[now.cursor + 1] ?? 0) <= t) now.cursor++;
      const recent = now.frames.slice(passedFrom, now.cursor + 1);
      const frame = now.frames[now.cursor] ?? null;
      if (now.cursor > 128) {
        const retired = now.cursor - 1;
        now.frames.splice(0, retired);
        now.times.splice(0, retired);
        now.cursor -= retired;
      }
      return { mode: "live", frame, recent, t, score: now.score };
    }
    if (this.ghost) {
      const ghost = this.ghost;
      const { frames, times, score, duration } = ghost;
      // Still being computed: show each new state as it arrives, a slow-motion first reading.
      if (duration === null) {
        const frame = frames[frames.length - 1] ?? null;
        return { mode: "ghost", frame, recent: frame ? [frame] : [], t: times[times.length - 1] ?? 0, score };
      }
      const t = (performance.now() / 1000) % (duration + 1.2);
      let low = 0;
      let high = times.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((times[middle] ?? 0) <= t) low = middle;
        else high = middle - 1;
      }
      const recent =
        low >= ghost.cursor ? frames.slice(ghost.cursor, low + 1) : [frames[low] as Float32Array];
      ghost.cursor = low;
      return { mode: "ghost", frame: frames[low] ?? null, recent, t, score };
    }
    return { mode: "idle", frame: null, recent: [], t: 0, score: null };
  }

  /** A score planned now, without speaking it. */
  async plan(input: string | Song, body?: Body): Promise<Score> {
    const voice = this.voice ?? (await this.load());
    return voice.plan(input as string, body === undefined ? {} : { body });
  }
}

export const studio = new Studio();
