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
  return playWith(sampleRate, options, async (player, stopped, context) => {
    const start = context.currentTime;
    let pushed = 0;
    let worked = performance.now();
    for await (const chunk of source) {
      if (stopped()) return;
      const copy = chunk.slice();
      player.port.postMessage(copy, [copy.buffer]);
      pushed += copy.length;
      // Stay at most `ahead` seconds in front of playback, and let the page breathe.
      for (;;) {
        const lead = pushed / sampleRate - (context.currentTime - start);
        if (stopped() || lead <= ahead) break;
        await sleep(Math.min(50, (lead - ahead) * 1000));
        worked = performance.now();
      }
      if (performance.now() - worked > 8) {
        await sleep(0);
        worked = performance.now();
      }
    }
    if (!stopped()) player.port.postMessage("end");
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
  attach: (port: MessagePort, stopped: () => boolean) => Promise<void>,
  onStop: () => void,
): Playback {
  return playWith(
    sampleRate,
    options,
    async (player, stopped) => {
      const { port1, port2 } = new MessageChannel();
      player.port.postMessage({ port: port2 }, [port2]);
      await attach(port1, stopped);
    },
    onStop,
  );
}

/** Sends a player its chunks and its "end"; `stopped` turns true when playback is stopped. */
type Feed = (player: AudioWorkletNode, stopped: () => boolean, context: BaseAudioContext) => Promise<void>;

function playWith(sampleRate: number, options: PlayOptions, feed: Feed, onStop?: () => void): Playback {
  const context = options.context ?? new AudioContext({ sampleRate, latencyHint: "interactive" });
  const owned = options.context === undefined;
  // Before anything is awaited: on iOS only code still inside the tap may start audio.
  if (context instanceof AudioContext) unlockAudio(context);
  let node: AudioWorkletNode | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    node?.port.postMessage("stop");
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

  // `done`'s only other source is the AudioWorklet's own "done" message, posted from inside
  // `process()` (see PROCESSOR below) -- which the browser stops calling the moment the context
  // it runs on closes. A caller-owned context closed directly (not through `stop()`) therefore
  // never posts it: `done` would hang forever, found live by e2e/scenarios/reliability.ts's
  // "context closed mid-stream" case (confirmed: still pending after 140s, not just slow). Treat
  // an external close the same as `stop()` and settle both promises ourselves; the real underrun
  // count is unknowable once the audio thread has stopped running, so this reports 0.
  let onContextClosed: (() => void) | undefined;
  // `instanceof AudioContext` alone isn't enough: a caller-supplied `options.context` only has to
  // satisfy BaseAudioContext, and a test double can pass `instanceof` (by swapping the global
  // AudioContext it's checked against) without implementing EventTarget at all -- found live by
  // player.test.ts's "wakes the context ... while still inside the tap" case, which crashed with
  // "context.addEventListener is not a function" once this guard was added. Real AudioContexts
  // always have it; this just stops a partial double from crashing a caller that never asked for
  // the new behavior.
  if (!owned && context instanceof AudioContext && typeof context.addEventListener === "function") {
    onContextClosed = () => {
      if (context.state !== "closed") return;
      stopped = true;
      markQueued();
      markDone({ underruns: 0 });
    };
    context.addEventListener("statechange", onContextClosed);
  }

  const run = async (): Promise<PlaybackEnd> => {
    try {
      // `addProcessor` and the node below can both reject or throw (no AudioWorklet support, a
      // strict CSP blocking the blob: URL it loads through). Everything that can fail is inside
      // this try, so `queued` always settles in `finally` instead of hanging forever while `done`
      // rejects on its own: a caller awaiting either promise gets a clear outcome, never a stall.
      await addProcessor(context);
      if (context instanceof AudioContext && context.state !== "running") void context.resume();
      const player = new AudioWorkletNode(context, "intone-player", {
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
      await feed(player, () => stopped, context);
      if (stopped) player.port.postMessage("stop");
      return await finished;
    } finally {
      markQueued();
      // A context closed externally (the case onContextClosed exists for) also makes
      // disconnect() throw InvalidStateError; nothing is listening on the audio thread by then
      // either way, so this is a safe no-op in that case.
      try {
        node?.disconnect();
      } catch {
        // already closed
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
class IntonePlayer extends AudioWorkletProcessor {
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
registerProcessor("intone-player", IntonePlayer);
`;
