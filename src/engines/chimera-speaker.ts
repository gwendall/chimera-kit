/**
 * CHIMERA behind the shared `Speaker` interface (`../speaker.ts`). A thin wrapper: the worker and
 * its guarantees (samples straight to the audio thread, `stop()` before anything plays gives
 * silence, `queued` confirmed by the audio thread) are `createWorkerVoice`'s own, unchanged here.
 * CHIMERA honors a text request's body, rate, f0, accent and delivery exactly, and sings a song's
 * notes, so nothing is ever lost.
 */
import type {
  Song,
  Speaker,
  SpeakerSayOptions,
  SpeakerStreamOptions,
  SpokenPlayback,
  SpokenRendered,
  Supports,
} from "../speaker.js";
import { createWorkerVoice, type WorkerVoiceOptions } from "../worker-voice.js";

export interface ChimeraSpeakerOptions extends WorkerVoiceOptions {}

const SUPPORTS: Supports = {
  pitchCurve: true,
  soundTiming: true,
  breath: true,
  phones: true,
  langs: ["en"],
  bodies: ["male", "female", "child"],
  singing: true,
};

/** CHIMERA has no gap for a text request: body, rate, f0 and accent are all honored exactly. */
const NOTHING_LOST: string[] = [];

export async function createChimeraSpeaker(options: ChimeraSpeakerOptions = {}): Promise<Speaker> {
  const voice = await createWorkerVoice(options);
  return {
    id: "chimera",
    accepts: "gestures",
    output: "samples",
    supports: SUPPORTS,
    sampleRate: voice.sampleRate,

    async render(text: string | Song, speakOptions?: SpeakerStreamOptions): Promise<SpokenRendered> {
      const rendered = await voice.render(text, speakOptions);
      return { ...rendered, lost: NOTHING_LOST };
    },

    async *stream(text: string | Song, speakOptions?: SpeakerStreamOptions) {
      for await (const chunk of voice.stream(text, speakOptions)) yield chunk;
      return NOTHING_LOST;
    },

    say(text, speakOptions: SpeakerSayOptions = {}): SpokenPlayback {
      const playback = voice.say(text, speakOptions);
      return {
        queued: playback.queued,
        done: playback.done.then(() => undefined),
        lost: NOTHING_LOST,
        stop: playback.stop,
      };
    },

    free(): void {
      voice.free();
    },
  };
}
