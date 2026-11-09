/**
 * `intone/live`: a held, playable voice over CHIMERA's physical model, plus the beatbox it
 * already has. `noteOn` opens the breath gate right on the audio thread (`worklet-live.ts`), so a
 * note sounds within a render quantum or two; `vowel`/`shape`/`source`/`bend` move the mouth and
 * the source while it holds, the way a program or a finger would.
 *
 * Control calls cross to the audio thread as messages, so a call that the engine rejects (an
 * unknown vowel, a non-finite value, an unknown beat sound) cannot throw back at the caller the
 * way a direct function call would; it is reported through `onError` instead, and the engine is
 * left exactly as it was.
 */
import {
  type ArticValues,
  type BeatHit,
  type BeatTempo,
  type Body,
  type ChimeraLiveSources,
  compileLiveWasm,
  type FromLive,
  type LiveTelemetry,
  type ShapeOptions,
  type SourceValues,
  type ToLive,
} from "./engines/chimera-live.js";
import { unlockAudio } from "./player.js";

export type {
  ArticValues,
  BeatHit,
  BeatTempo,
  Body,
  LiveTelemetry,
  ShapeOptions,
  Source,
  SourceValues,
} from "./engines/chimera-live.js";

export interface CreateInstrumentOptions extends ChimeraLiveSources {
  /** Where to play. Defaults to a new AudioContext, closed on `free()`. */
  context?: BaseAudioContext;
  /** Defaults to the context's destination. */
  destination?: AudioNode;
  /** The worklet module's location. Defaults to `worklet-live.js` next to this module. */
  worklet?: URL | string;
  /** A control call the worklet rejected: the engine was left unchanged. */
  onError?: (message: string) => void;
}

export interface Beat {
  /** One hit, by pattern symbol or sound name ("kick" or "B"), case-insensitively either way. */
  hit(id: string, options?: { note?: number; accent?: number }): void;
  /** Replaces the sequencer's pattern ("kick . snare ." or "B . Pf ."). */
  steps(pattern: string): void;
  /** Sets the tempo (if given) and starts the sequencer. */
  start(tempo?: BeatTempo): void;
  stop(): void;
}

export interface Instrument {
  setBody(body: Body): void;
  shape(values: ArticValues, options?: ShapeOptions): void;
  source(values: SourceValues): void;
  vowel(ipa: string): void;
  /** Starts a note: `velocity` is the breath gate (0..1.5; 1, the default, is a plain note). */
  noteOn(midi: number, velocity?: number): void;
  noteOff(): void;
  /** Glides to a new pitch while a note is held, without retriggering the gate. */
  bend(midi: number): void;
  readonly beat: Beat;
  /** The worklet's last telemetry snapshot (posted about 47 times a second), or null before the
   * first one has arrived. */
  telemetry(): LiveTelemetry | null;
  /** Disconnects and frees the engine. Safe to call while a note sounds or the beat plays. */
  free(): void;
  /** The underlying node, for connecting effects or reading `context.currentTime`. */
  readonly node: AudioWorkletNode;
}

const added = new WeakMap<BaseAudioContext, Promise<void>>();

function addWorkletModule(context: BaseAudioContext, url: URL | string): Promise<void> {
  let adding = added.get(context);
  if (!adding) {
    adding = context.audioWorklet.addModule(String(url));
    added.set(context, adding);
  }
  return adding;
}

/** Creates a worklet node, falling back to raw bytes if the engine's compiled `WebAssembly.Module`
 * cannot cross into the worklet's realm (Safari, at least some versions, refuses to structured-
 * clone a compiled module into an AudioWorkletProcessor). */
function createNode(
  context: BaseAudioContext,
  module: WebAssembly.Module,
  bytes: Uint8Array,
): AudioWorkletNode {
  const base: Pick<AudioWorkletNodeOptions, "numberOfInputs" | "outputChannelCount"> = {
    numberOfInputs: 0,
    outputChannelCount: [1],
  };
  try {
    return new AudioWorkletNode(context, "intone-live", { ...base, processorOptions: { module } });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "DataCloneError")) throw error;
    return new AudioWorkletNode(context, "intone-live", { ...base, processorOptions: { bytes } });
  }
}

/** Loads the engine into a worklet and returns a playable instrument. */
export async function createInstrument(options: CreateInstrumentOptions = {}): Promise<Instrument> {
  const { context: given, destination, worklet, onError, wasm } = options;
  const context = given ?? new AudioContext({ latencyHint: "interactive" });
  const owned = given === undefined;
  // Before anything is awaited: on iOS only code still inside the tap may start an AudioContext.
  if (context instanceof AudioContext) unlockAudio(context);

  const workletUrl = worklet ?? new URL("./worklet-live.js", import.meta.url);
  const [, { module, bytes }] = await Promise.all([
    addWorkletModule(context, workletUrl),
    compileLiveWasm(wasm),
  ]);
  if (context instanceof AudioContext && context.state !== "running") void context.resume();

  const node = createNode(context, module, bytes);
  node.connect(destination ?? context.destination);
  const send = (message: ToLive) => node.port.postMessage(message);

  let lastTelemetry: LiveTelemetry | null = null;
  let onReady: (() => void) | undefined;
  let onReadyFail: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    onReady = resolve;
    onReadyFail = reject;
  });
  node.port.onmessage = ({ data }: MessageEvent<FromLive>) => {
    if (data.type === "ready") {
      onReady?.();
      onReady = onReadyFail = undefined;
    } else if (data.type === "telemetry") {
      lastTelemetry = data.data;
    } else if (data.type === "error") {
      if (onReadyFail) {
        onReadyFail(new Error(`intone: ${data.message}`));
        onReady = onReadyFail = undefined;
      } else {
        onError?.(data.message);
      }
    }
  };
  try {
    await ready;
  } catch (error) {
    node.disconnect();
    if (owned) await (context as AudioContext).close();
    throw error;
  }

  const instrument: Instrument = {
    setBody(body) {
      send({ type: "setBody", body });
    },
    shape(values, shapeOptions) {
      send(
        shapeOptions === undefined
          ? { type: "shape", values }
          : { type: "shape", values, options: shapeOptions },
      );
    },
    source(values) {
      send({ type: "source", values });
    },
    vowel(ipa) {
      send({ type: "vowel", ipa });
    },
    noteOn(midi, velocity) {
      send(velocity === undefined ? { type: "noteOn", midi } : { type: "noteOn", midi, velocity });
    },
    noteOff() {
      send({ type: "noteOff" });
    },
    bend(midi) {
      send({ type: "bend", midi });
    },
    beat: {
      hit(id, hitOptions) {
        const hit: BeatHit = hitOptions === undefined ? { id } : { id, ...hitOptions };
        send({ type: "beatHit", hit });
      },
      steps(pattern) {
        send({ type: "beatSteps", pattern });
      },
      start(tempo) {
        if (tempo !== undefined) send({ type: "beatTempo", tempo });
        send({ type: "beatPlaying", playing: true });
      },
      stop() {
        send({ type: "beatPlaying", playing: false });
      },
    },
    telemetry() {
      return lastTelemetry;
    },
    free() {
      send({ type: "free" });
      node.disconnect();
      if (owned) void (context as AudioContext).close();
    },
    node,
  };
  return instrument;
}
