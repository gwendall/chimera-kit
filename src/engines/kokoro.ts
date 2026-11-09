/**
 * The Kokoro engine (`kokoro-js`, an 82M-parameter neural TTS model run through Transformers.js):
 * a prototype adapter, reachable only through the `intone/kokoro` entry so that `kokoro-js` and
 * its model never reach anyone importing the core package. See `docs/design.md`'s Engines
 * section and the table there for how its shape differs from CHIMERA's.
 *
 * Unlike CHIMERA, Kokoro is async (loading and generating both go through ONNX Runtime) and has
 * no per-sample or per-chunk control: it renders a sentence at a time, at 24 kHz, with one style
 * vector and one `speed` for the whole call. There is no streaming chunk smaller than a sentence,
 * and no sample-accurate timing at all. See this file's `KokoroVoice` for the interface this
 * prototype uses, and the package's report for a recommendation on how `../voice.ts`'s `Voice`
 * should grow to cover both engines.
 */

import { Tensor } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream } from "kokoro-js";
import type { Score } from "../layers.js";
import {
  type KokoroDevice,
  type KokoroDtype,
  resolveSpeed,
  validateDevice,
  validateDtype,
} from "./kokoro-options.js";
import { type EncodedPhones, encodeSoundsForKokoro } from "./kokoro-phones.js";

const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";
/** `generate`/`generate_from_ids`'s fixed output rate (`SAMPLE_RATE` in `kokoro-js`). */
export const KOKORO_SAMPLE_RATE = 24000;

export interface KokoroVoiceOptions {
  /** One of `KokoroTTS.prototype.voices`' 28 English ids, e.g. `"af_heart"` (the default). */
  voice?: string;
  /** Quantization of the downloaded model. Defaults to `"q8"`: about 92 MB, fp32 is about 325 MB. */
  dtype?: KokoroDtype;
  /** Execution backend. `null`/undefined lets `kokoro-js` choose (plain CPU in Node/Bun). */
  device?: KokoroDevice | null;
  /** Overrides the Hugging Face model id, e.g. to pin a revision. */
  modelId?: string;
  /** This voice's default speaking-rate multiplier; a per-call `rate` overrides it. */
  rate?: number;
}

export interface KokoroSpeakOptions {
  /** Speaking-rate multiplier, mapped straight to Kokoro's own `speed`. From 0 (exclusive) to 4. */
  rate?: number;
}

export interface KokoroRendered {
  /** Mono samples, nominally within -1 to 1, at `KOKORO_SAMPLE_RATE`. */
  audio: Float32Array;
  sampleRate: number;
}

export interface KokoroRenderedScore extends KokoroRendered {
  /** What the request asked for that Kokoro has no way to honor; see `kokoro-phones.ts`. */
  lost: string[];
}

export interface KokoroVoice {
  readonly sampleRate: number;
  /** Renders the whole utterance at once, through Kokoro's own text-to-phoneme step. */
  render(text: string, options?: KokoroSpeakOptions): Promise<KokoroRendered>;
  /** One chunk per sentence: Kokoro has no finer granularity than that. */
  stream(text: string, options?: KokoroSpeakOptions): AsyncGenerator<Float32Array, void, undefined>;
  /**
   * Renders a score's phones directly through `generate_from_ids`, bypassing Kokoro's own
   * text-to-phoneme step. `lost` always includes the score features Kokoro has no input for
   * (pitch, per-sound timing, loudness, breath, tension), plus any phone `kokoro-phones.ts`
   * could not map.
   */
  renderScore(score: Score, options?: KokoroSpeakOptions): Promise<KokoroRenderedScore>;
  /** Best-effort: disposes the ONNX session. Kokoro holds no other resource to release. */
  free(): void;
}

/** `KokoroTTS.prototype.generate`'s own voice-id union, for the cast below: we accept any string
 * (the model may grow voices the installed `kokoro-js`'s types don't know about yet), and let
 * `KokoroTTS`'s own `_validate_voice` throw its clear error for a voice that doesn't exist. */
type VoiceId = NonNullable<NonNullable<Parameters<KokoroTTS["generate"]>[1]>["voice"]>;

function toBigInts(ids: readonly number[]): BigInt64Array {
  const data = new BigInt64Array(ids.length);
  for (let i = 0; i < ids.length; i++) data[i] = BigInt(ids[i] as number);
  return data;
}

/** Always true for a score rendered through Kokoro: it has no input for any of these. */
function scoreLost(score: Score, encoded: EncodedPhones): string[] {
  const lost = new Set(encoded.lost);
  lost.add("pitch curve");
  lost.add("per-sound timing");
  lost.add("exact silence duration");
  if (score.loudness) lost.add("loudness curve");
  if (score.breath) lost.add("breath curve");
  if (score.tension) lost.add("tension curve");
  return [...lost];
}

class KokoroVoiceImpl implements KokoroVoice {
  readonly sampleRate = KOKORO_SAMPLE_RATE;

  constructor(
    private readonly tts: KokoroTTS,
    private readonly voice: string,
    private readonly defaultRate: number | undefined,
  ) {}

  async render(text: string, options?: KokoroSpeakOptions): Promise<KokoroRendered> {
    const speed = resolveSpeed(options?.rate ?? this.defaultRate);
    const raw = await this.tts.generate(text, { voice: this.voice as VoiceId, speed });
    return { audio: raw.audio, sampleRate: raw.sampling_rate };
  }

  async *stream(text: string, options?: KokoroSpeakOptions): AsyncGenerator<Float32Array, void, undefined> {
    const speed = resolveSpeed(options?.rate ?? this.defaultRate);
    // kokoro-js's own `stream(text)` (plain string) pushes into an internal `TextSplitterStream`
    // but never closes it: the splitter withholds whatever sentence it last saw until it is sure
    // more text isn't coming right after it, which for a single complete sentence (the common
    // case here) never happens, so the last (and often only) sentence never reaches the output and
    // the call hangs forever. Pushing into our own stream and closing it forces that final flush;
    // found by `scripts/kokoro-check.ts` hanging on exactly one sentence with zero CPU or network
    // activity (verified with `sample`: the event loop had nothing scheduled).
    const input = new TextSplitterStream();
    input.push(text);
    input.close();
    for await (const { audio } of this.tts.stream(input, { voice: this.voice as VoiceId, speed })) {
      yield audio.audio;
    }
  }

  async renderScore(score: Score, options?: KokoroSpeakOptions): Promise<KokoroRenderedScore> {
    const speed = resolveSpeed(options?.rate ?? this.defaultRate);
    const encoded = encodeSoundsForKokoro(score.sounds, score.words);
    const inputIds = new Tensor("int64", toBigInts(encoded.ids), [1, encoded.ids.length]);
    const raw = await this.tts.generate_from_ids(inputIds, { voice: this.voice as VoiceId, speed });
    return { audio: raw.audio, sampleRate: raw.sampling_rate, lost: scoreLost(score, encoded) };
  }

  free(): void {
    this.tts.model.dispose().catch(() => {});
  }
}

/** Loads the Kokoro model (downloads it on first use) and returns a voice over it. */
export async function createKokoroVoice(options: KokoroVoiceOptions = {}): Promise<KokoroVoice> {
  const dtype = validateDtype(options.dtype);
  const device = validateDevice(options.device);
  const voice = options.voice ?? DEFAULT_VOICE;
  if (options.rate !== undefined) resolveSpeed(options.rate); // fail now, not on first render
  const tts = await KokoroTTS.from_pretrained(options.modelId ?? DEFAULT_MODEL_ID, {
    dtype,
    ...(device !== undefined ? { device } : {}),
  });
  return new KokoroVoiceImpl(tts, voice, options.rate);
}
