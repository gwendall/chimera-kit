/**
 * The device's own voices (Web Speech) behind the shared `Speaker` interface (`../speaker.ts`).
 * It plays itself and gives no samples (`output: "playback"`), so `render` and `stream` are left
 * out; `context` and `destination` (Web Audio routing) have no meaning here and are ignored.
 *
 * The chosen voice is fixed when the speaker is opened: a text request's `body` is always lost
 * when given. The system has no absolute pitch or per-syllable accent control, so `f0` and
 * `accent` are always lost too; `rate` is honored exactly (one multiplier per utterance, same as
 * `SpeakOptions`' own).
 */
import { atIntensity } from "../delivery.js";
import type { SpeakOptions } from "../engine.js";
import type { Speaker, SpeakerSayOptions, SpokenPlayback, Supports } from "../speaker.js";
import { createSystemVoice, type SayOptions, type SystemVoiceOptions } from "../web-speech.js";

export interface WebSpeechSpeakerOptions extends SystemVoiceOptions {}

/** What a call's options ask for that Web Speech cannot do: `f0` and `accent` have no input at
 * all, and `body` cannot change after the speaker was opened (see the module doc above). */
export function lostFor(options?: SpeakOptions): string[] {
  const lost: string[] = [];
  if (options?.f0 !== undefined) lost.push("f0");
  if (options?.accent !== undefined) lost.push("accent");
  if (options?.body !== undefined) lost.push("body");
  return lost;
}

export async function createWebSpeechSpeaker(options: WebSpeechSpeakerOptions = {}): Promise<Speaker> {
  const system = await createSystemVoice(options);
  const supports: Supports = {
    pitchCurve: false,
    soundTiming: false,
    breath: false,
    phones: false,
    langs: [system.voice.lang],
    bodies: [system.voice.name],
  };
  return {
    id: "web-speech",
    accepts: "intent",
    output: "playback",
    supports,

    say(text, speakOptions: SpeakerSayOptions = {}): SpokenPlayback {
      const { signal, rate, delivery, intensity } = speakOptions;
      const sayOptions: SayOptions = {};
      // One delivery for the system voice: the call's own, at its intensity, its rate times `rate`.
      if (delivery !== undefined || rate !== undefined) {
        const d = delivery === undefined ? {} : atIntensity(delivery, intensity);
        sayOptions.delivery = rate === undefined ? d : { ...d, rate: (d.rate ?? 1) * rate };
      }
      if (signal) sayOptions.signal = signal;
      const speech = system.say(text, sayOptions);
      return {
        // Web Speech has no queueing step of its own to confirm against: the system has been told
        // to speak as soon as `say` returns.
        queued: Promise.resolve(),
        done: speech.done,
        lost: [...new Set([...lostFor(speakOptions), ...speech.lost])],
        stop: speech.stop,
      };
    },

    free(): void {
      // Nothing to release: Web Speech holds no resource of its own beyond the utterance queue,
      // which `stop()` (via `say`) already clears.
    },
  };
}
