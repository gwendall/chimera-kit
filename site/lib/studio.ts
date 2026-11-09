// One voice, one audio graph and one clock for the whole page: every demo speaks through here, and
// the throat on the right draws whatever is sounding now.
import { type Creatures, loadCreatures } from "./intone/creatures.js";
import {
  type Body,
  createVoice,
  deliver,
  type Mood,
  type Playback,
  play,
  type Score,
  type Song,
  speech,
  unlockAudio,
  type Voice,
} from "./intone/index.js";

export interface Snapshot {
  ready: boolean;
  speaking: boolean;
  /** Milliseconds from the call to the first sample computed, for the last thing spoken. */
  firstSampleMs: number | null;
  label: string;
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

interface SpeakOptions {
  body?: Body;
  style?: Mood;
  intensity?: number;
  label?: string;
}

const GHOST_LINE = "I do not have a body, but I do have a throat.";
const SAMPLE_RATE = 48_000;

class Studio {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { ready: false, speaking: false, firstSampleMs: null, label: "" };
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
  } | null = null;
  private serial = 0;
  /** A creature's picture stays up for a moment after its call ends. */
  private scopeUntil = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Starts loading the engine; safe to call any number of times. */
  load(): Promise<Voice> {
    this.loading ??= createVoice({ body: "female" }).then((voice) => {
      this.voice = voice;
      this.set({ ready: true });
      void this.buildGhost(voice);
      return voice;
    });
    return this.loading;
  }

  /** A real, silent reading, computed in small slices, that keeps the throat moving before any click. */
  private async buildGhost(voice: Voice) {
    const score = voice.plan(GHOST_LINE);
    const frames: Float32Array[] = [];
    const times: number[] = [];
    let samples = 0;
    const ghost = { frames, times, score, duration: null as number | null, cursor: 0 };
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
      this.output.minDecibels = -92;
      this.output.maxDecibels = -18;
      this.output.connect(this.context.destination);
    }
    unlockAudio(this.context);
    return { context: this.context, output: this.output };
  }

  /** Called on every tap until sound is allowed, so a demo may await something before it speaks. */
  unlock(): boolean {
    return this.audio().context.state === "running";
  }

  get analyser(): AnalyserNode | null {
    return this.output;
  }

  stop() {
    this.serial++;
    this.playback?.stop();
    this.playback = null;
    this.sounding = null;
    this.set({ speaking: false });
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
    this.set({ speaking: true, label });
    return sounding;
  }

  private watch(sounding: Sounding, playback: Playback) {
    this.playback = playback;
    void playback.done.then(() => {
      if (this.sounding?.id !== sounding.id) return;
      if (sounding.kind === "creature") this.scopeUntil = performance.now() + 1600;
      this.sounding = null;
      this.playback = null;
      this.set({ speaking: false });
    });
  }

  /** Records when the first sample left, and on which clock, then hands the chunks on. */
  private *timed(
    chunks: Iterable<Float32Array>,
    sounding: Sounding,
    context: AudioContext,
    calledAt: number,
    onSample: (n: number) => void,
  ) {
    let samples = 0;
    for (const chunk of chunks) {
      if (sounding.startedAt === null) {
        sounding.startedAt = context.currentTime + context.baseLatency + (context.outputLatency || 0);
        this.set({ firstSampleMs: performance.now() - calledAt });
      }
      samples += chunk.length;
      onSample(samples);
      yield chunk;
    }
  }

  /** Text, a song or a score, spoken at once. Text and songs are planned first, so the page can draw them. */
  async speak(input: string | Song | Score, options: SpeakOptions = {}) {
    const { context, output } = this.audio();
    const voice = this.voice ?? (await this.load());
    const calledAt = performance.now();
    const { body, style, intensity, label } = options;
    const voiced = {
      ...(body === undefined ? {} : { body }),
      ...(style === undefined ? {} : { style: deliver(style, intensity ?? 1) }),
    };
    const score = typeof input === "string" || "notes" in input ? voice.plan(input as string, voiced) : input;
    const sounding = this.begin("voice", score, label ?? "");
    let samples = 0;
    const chunks = voice.stream(score, {
      ...(body === undefined ? {} : { body }),
      airway: (state) => this.record(sounding, state, samples / voice.sampleRate),
    });
    const timed = this.timed(chunks, sounding, context, calledAt, (n) => {
      samples = n;
    });
    this.watch(sounding, play(timed, voice.sampleRate, { context, destination: output }));
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
          studio.set({ firstSampleMs: performance.now() - calledAt });
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
    sounding.startedAt = context.currentTime;
    const creature = zoo.create(id, params);
    const playback = play(creature.stream(call, { chunkSize: 512 }), zoo.sampleRate, {
      context,
      destination: output,
    });
    this.watch(sounding, playback);
    void playback.done.finally(() => creature.free());
  }

  private record(sounding: Sounding, state: Float32Array, t: number) {
    sounding.frames.push(state);
    sounding.times.push(t);
  }

  /** What the throat should show at this instant. */
  read(): Reading {
    const now = this.sounding;
    if (now?.kind === "creature" || performance.now() < this.scopeUntil) {
      return { mode: "scope", frame: null, recent: [], t: 0, score: null };
    }
    if (now && this.context && now.startedAt !== null) {
      const t = Math.max(0, this.context.currentTime - now.startedAt);
      const passedFrom = now.cursor;
      while (now.cursor + 1 < now.times.length && (now.times[now.cursor + 1] ?? 0) <= t) now.cursor++;
      const recent = now.frames.slice(passedFrom, now.cursor + 1);
      const frame = now.frames[now.cursor] ?? null;
      if (now.cursor > 6000) {
        now.frames.splice(0, 5000);
        now.times.splice(0, 5000);
        now.cursor -= 5000;
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
