/**
 * Plays samples in a browser while they are computed. An AudioWorklet reads from a queue that the
 * caller's thread fills a little ahead of playback, so speech starts with the first chunk.
 */

export interface PlayOptions {
  /** Where to play. Defaults to a new AudioContext at the source's rate, closed at the end. */
  context?: BaseAudioContext;
  /** Defaults to the context's destination. */
  destination?: AudioNode;
  /** Stops playback when aborted. */
  signal?: AbortSignal;
  /** Seconds of audio computed ahead of playback (default 0.25). `Infinity` computes it all. */
  ahead?: number;
}

export interface Playback {
  /** Every sample that will play has reached the audio thread (none, after a stop). */
  queued: Promise<void>;
  /** The last sample has played, or playback was stopped. */
  done: Promise<PlaybackEnd>;
  stop(): void;
}

export interface PlaybackEnd {
  /** Times the audio thread ran out of samples after playback had started. */
  underruns: number;
}

type Source = Iterable<Float32Array> | AsyncIterable<Float32Array>;

/** @internal Stops reading promptly even when a source never settles its next or return call. */
export async function* readUntilAborted<T>(
  source: Iterable<T> | AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, undefined> {
  const iterator =
    Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  let interrupt: () => void = () => {};
  const cancelled = new Promise<undefined>((resolve) => {
    interrupt = () => resolve(undefined);
  });
  signal.addEventListener("abort", interrupt, { once: true });
  let ended = false;
  try {
    while (!signal.aborted) {
      const next = await Promise.race([iterator.next(), cancelled]);
      if (!next || signal.aborted) return;
      if (next.done) {
        ended = true;
        return;
      }
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", interrupt);
    if (!ended) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        // Teardown is best effort: cancellation must not wait for or reject with the source.
      }
    }
  }
}

// Half a second of silence, a WAV of zeros (the trailing "A"s).
const SILENCE = `data:audio/wav;base64,UklGRmAfAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YTwfAAAA${"A".repeat(10660)}`;
let silence: HTMLAudioElement | undefined;

/**
 * Lets sound through on phones. iOS mutes Web Audio with the silent switch unless the page asks for
 * the "playback" audio session, and only starts a context from code running inside a tap. `play`
 * calls this itself. Call it from your click handler when `play` only comes after an `await`.
 *
 * iOS before 16.4 has no audio session API, where a looping silent media element does the same.
 * An app that set `navigator.audioSession.type` itself keeps its choice.
 */
export function unlockAudio(context?: AudioContext): void {
  if (context && context.state !== "running") void context.resume().catch(() => {});
  if (typeof navigator === "undefined") return;
  const session = (navigator as { audioSession?: { type: string } }).audioSession;
  if (session) {
    if (session.type === "auto") session.type = "playback";
    return;
  }
  const iOS =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!iOS) return;
  if (!silence) {
    silence = new Audio(SILENCE);
    silence.loop = true;
    silence.setAttribute("playsinline", "");
  }
  if (silence.paused) void silence.play().catch(() => {});
}

/** Starts playing `source`, chunks of mono samples at `sampleRate`. */
export function play(source: Source, sampleRate: number, options: PlayOptions = {}): Playback {
  const ahead = options.ahead ?? 0.25;
  return playWith(sampleRate, options, async (player, signal, context) => {
    const start = context.currentTime;
    let pushed = 0;
    let worked = performance.now();
    for await (const chunk of readUntilAborted(source, signal)) {
      if (signal.aborted) return;
      const copy = chunk.slice();
      player.port.postMessage(copy, [copy.buffer]);
      pushed += copy.length;
      // Stay at most `ahead` seconds in front of playback, and let the page breathe.
      for (;;) {
        const lead = pushed / sampleRate - (context.currentTime - start);
        if (signal.aborted || lead <= ahead) break;
        await sleep(Math.min(50, (lead - ahead) * 1000));
        worked = performance.now();
      }
      if (performance.now() - worked > 8) {
        await sleep(0);
        worked = performance.now();
      }
    }
    if (!signal.aborted) player.port.postMessage("end");
  });
}

/**
 * Plays chunks that someone else sends straight to the audio thread, such as a Worker, so they
 * never wait for the page. `attach` gets the port to send them on, then "end" after the last.
 * @internal
 */
export function playThrough(
  sampleRate: number,
  options: PlayOptions,
  attach: (port: MessagePort, signal: AbortSignal) => Promise<void>,
  onStop: () => void,
): Playback {
  return playWith(
    sampleRate,
    options,
    async (player, signal) => {
      const { port1, port2 } = new MessageChannel();
      try {
        player.port.postMessage({ port: port2 }, [port2]);
        await attach(port1, signal);
      } finally {
        port1.close();
        port2.close();
      }
    },
    onStop,
  );
}

/** Sends a player its chunks and its "end" until playback is stopped. */
type Feed = (player: AudioWorkletNode, signal: AbortSignal, context: BaseAudioContext) => Promise<void>;

function playWith(sampleRate: number, options: PlayOptions, feed: Feed, onStop?: () => void): Playback {
  const context = options.context ?? new AudioContext({ sampleRate, latencyHint: "interactive" });
  const owned = options.context === undefined;
  // Before anything is awaited: on iOS only code still inside the tap may start audio.
  if (context instanceof AudioContext) unlockAudio(context);
  let node: AudioWorkletNode | undefined;
  const controller = new AbortController();
  let markCancelled: (end: PlaybackEnd) => void = () => {};
  const cancelled = new Promise<PlaybackEnd>((resolve) => {
    markCancelled = resolve;
  });
  const stop = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    node?.port.postMessage("stop");
    markCancelled({ underruns: 0 });
    onStop?.();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  let markQueued: () => void = () => {};
  let markDone: (end: PlaybackEnd) => void = () => {};
  const queued = new Promise<void>((resolve) => {
    markQueued = resolve;
  });
  const finished = new Promise<PlaybackEnd>((resolve) => {
    markDone = resolve;
  });

  // The worklet posts "done" from `process()`, which a closed context no longer calls: a caller
  // closing its own context mid-stream would leave `done` pending forever. Such a close is a
  // `stop()`; the underruns are unknowable once the audio thread has stopped, so it reports 0.
  // (The `addEventListener` check spares a caller's partial context double.)
  let onContextClosed: (() => void) | undefined;
  if (!owned && context instanceof AudioContext && typeof context.addEventListener === "function") {
    onContextClosed = () => {
      if (context.state !== "closed") return;
      stop();
      markQueued();
      markDone({ underruns: 0 });
    };
    context.addEventListener("statechange", onContextClosed);
  }

  const run = async (): Promise<PlaybackEnd> => {
    try {
      // Loading the processor can fail (no AudioWorklet, a CSP refusing blob: URLs): inside the
      // try, `queued` still settles in `finally` and `done` rejects, so neither hangs.
      await Promise.race([addProcessor(context), cancelled]);
      if (controller.signal.aborted) return await cancelled;
      if (context instanceof AudioContext && context.state !== "running") void context.resume();
      const player = new AudioWorkletNode(context, "chimera-kit-player", {
        numberOfInputs: 0,
        outputChannelCount: [1],
        processorOptions: { sourceRate: sampleRate },
      });
      node = player;
      player.port.onmessage = ({ data }) => {
        if (data?.queued !== undefined) markQueued();
        if (data?.done) markDone({ underruns: data.underruns });
      };
      player.connect(options.destination ?? context.destination);
      await Promise.race([feed(player, controller.signal, context), cancelled]);
      return await Promise.race([finished, cancelled]);
    } catch (error) {
      stop();
      throw error;
    } finally {
      markQueued();
      try {
        node?.disconnect();
      } catch {
        // A closed context's node throws InvalidStateError here, with nothing left to disconnect.
      }
      options.signal?.removeEventListener("abort", stop);
      if (onContextClosed) context.removeEventListener("statechange", onContextClosed);
      if (owned) await (context as AudioContext).close();
    }
  };

  return { queued, done: run(), stop };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const added = new WeakMap<BaseAudioContext, Promise<void>>();

function addProcessor(context: BaseAudioContext): Promise<void> {
  let adding = added.get(context);
  if (!adding) {
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: "text/javascript" }));
    adding = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    added.set(context, adding);
  }
  return adding;
}

/**
 * Runs on the audio thread. Holds the chunks it was sent and reads them at the context's rate,
 * interpolating linearly when that differs from the source's.
 */
const PROCESSOR = `
class ChimeraPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.step = options.processorOptions.sourceRate / sampleRate;
    this.chunks = [];
    this.offset = 0;
    this.available = 0;
    this.position = 0;
    this.ended = false;
    this.started = false;
    this.starved = false;
    this.underruns = 0;
    this.stopped = false;
    // Chunks come on this port, or on another one it is given (a Worker's), never both.
    const receive = ({ data }) => {
      if (data instanceof Float32Array) {
        if (this.stopped) return;
        this.chunks.push(data);
        this.available += data.length;
      } else if (data === "end") {
        this.ended = true;
        this.port.postMessage({ queued: this.available });
      } else if (data === "stop") {
        this.chunks = [];
        this.offset = this.available = this.position = 0;
        this.ended = this.stopped = true;
        // Nothing more will play. Said from here, so an offline render can start after it.
        this.port.postMessage({ queued: 0 });
      } else if (data && data.port) {
        data.port.onmessage = receive;
      }
    };
    this.port.onmessage = receive;
  }
  at(i) {
    let k = i - this.offset;
    for (const chunk of this.chunks) {
      if (k < chunk.length) return chunk[k];
      k -= chunk.length;
    }
    return 0;
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    let j = 0;
    for (; j < out.length; j++) {
      const i = Math.floor(this.position);
      const f = this.position - i;
      if ((f > 0 ? i + 2 : i + 1) > this.available) break;
      const a = this.at(i);
      out[j] = f > 0 ? a + (this.at(i + 1) - a) * f : a;
      this.position += this.step;
    }
    if (j > 0) this.started = true;
    if (j < out.length) {
      out.fill(0, j);
      if (this.ended) {
        this.port.postMessage({ done: true, underruns: this.underruns });
        return false;
      }
      if (this.started && !this.starved) this.underruns++;
      this.starved = true;
    } else {
      this.starved = false;
    }
    while (this.chunks.length > 0 && Math.floor(this.position) - this.offset >= this.chunks[0].length) {
      this.offset += this.chunks.shift().length;
    }
    return true;
  }
}
registerProcessor("chimera-kit-player", ChimeraPlayer);
`;
