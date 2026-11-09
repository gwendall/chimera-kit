/**
 * The device's own voices, through the browser's speech synthesis (Web Speech). Nothing to
 * download and it plays by itself, but it takes only text, with one rate, pitch and volume per
 * utterance: the rest of a delivery is lost, and every call says what.
 */
import { clauses } from "./clauses.js";
import { type Delivery, MOODS, type Mood } from "./delivery.js";

export interface SystemVoiceOptions {
  /** A BCP 47 language tag, matched by prefix: "en" takes any English voice. Default "en". */
  lang?: string;
  /** Picks a voice by name, such as "Samantha" or /google/i. */
  name?: string | RegExp;
  /** The synthesizer to use. Defaults to the page's `speechSynthesis`. */
  synth?: SpeechSynthesis;
  /** The utterance constructor. Defaults to the page's `SpeechSynthesisUtterance`. */
  Utterance?: typeof SpeechSynthesisUtterance;
}

export interface SayOptions {
  /** How to say it: a mood's name or departures from neutral. */
  delivery?: Delivery | Mood;
  /** How far to take the delivery: 0 is neutral, 1 as written. Default 1. */
  intensity?: number;
  /** Stops speaking when aborted. */
  signal?: AbortSignal;
}

export interface SystemSpeech {
  /** Every clause has been spoken, or speech was stopped. */
  done: Promise<void>;
  /** What the system voice could not do of the delivery, such as "pitch range". */
  lost: string[];
  stop(): void;
}

export interface SystemVoice {
  /** The voice the system picked. */
  readonly voice: SpeechSynthesisVoice;
  /**
   * Speaks text, or text that is still arriving (a language model's tokens), clause by clause.
   * Markdown is read as words.
   */
  say(text: string | Iterable<string> | AsyncIterable<string>, options?: SayOptions): SystemSpeech;
}

/** Utterance settings for a delivery, and what does not fit them. */
export function systemSettings(
  delivery: Delivery | Mood = {},
  intensity = 1,
): { rate: number; pitch: number; volume: number; lost: string[] } {
  const d: Delivery = typeof delivery === "string" ? MOODS[delivery] : delivery;
  if (!d) throw new RangeError(`intone: no mood "${delivery}". Moods: ${Object.keys(MOODS).join(", ")}`);
  const k = intensity;
  const lost: string[] = [];
  const rate = (d.rate ?? 1) ** k;
  // Web Speech leaves the pitch scale to the system: 1 is normal, 0 and 2 the extremes. An octave
  // each way is a guess that sounds right on macOS and Chrome; it is not specified anywhere.
  const pitch = 1 + ((d.pitch ?? 0) * k) / 12;
  const volume = 10 ** (((d.gain ?? 0) * k) / 20);
  if (rate < 0.1 || rate > 10) lost.push("rate beyond 0.1 to 10");
  if (pitch < 0 || pitch > 2) lost.push("pitch beyond an octave");
  if (volume > 1) lost.push("level above full volume");
  if (d.range !== undefined && d.range !== 1 && k > 0) lost.push("pitch range");
  if (d.breath && k > 0) lost.push("breath");
  if (d.tension && k > 0) lost.push("tension");
  if (d.pauses !== undefined && d.pauses !== 1 && k > 0) lost.push("pause length");
  return {
    rate: Math.min(10, Math.max(0.1, rate)),
    pitch: Math.min(2, Math.max(0, pitch)),
    volume: Math.min(1, volume),
    lost,
  };
}

/** The system voices, once the browser has listed them (some list them late). */
export function systemVoices(
  synth: SpeechSynthesis = speechSynthesis,
  wait = 1000,
): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      synth.removeEventListener("voiceschanged", done);
      resolve(synth.getVoices());
    };
    const timer = setTimeout(done, wait);
    synth.addEventListener("voiceschanged", done);
  });
}

/** A voice of the device, chosen by language and optionally by name. */
export async function createSystemVoice(options: SystemVoiceOptions = {}): Promise<SystemVoice> {
  const synth = options.synth ?? globalThis.speechSynthesis;
  const Utterance = options.Utterance ?? globalThis.SpeechSynthesisUtterance;
  if (!synth || !Utterance) throw new Error("intone: this environment has no speech synthesis");
  const lang = (options.lang ?? "en").toLowerCase();
  const voices = (await systemVoices(synth)).filter((v) => v.lang.toLowerCase().startsWith(lang));
  const { name } = options;
  const named =
    name === undefined
      ? voices
      : voices.filter((v) => (typeof name === "string" ? v.name.includes(name) : name.test(v.name)));
  const voice = named.find((v) => v.localService) ?? named[0];
  if (!voice) {
    const listed = voices.map((v) => v.name).join(", ") || "none";
    throw new RangeError(
      `intone: no system voice for ${options.lang ?? "en"}${name ? ` named ${name}` : ""}. Voices: ${listed}`,
    );
  }
  return {
    voice,
    say(text, sayOptions = {}) {
      const settings = systemSettings(sayOptions.delivery, sayOptions.intensity);
      let stopped = false;
      const stop = () => {
        stopped = true;
        synth.cancel();
      };
      sayOptions.signal?.addEventListener("abort", stop, { once: true });
      if (sayOptions.signal?.aborted) stopped = true;
      const speakOne = (clause: string) =>
        new Promise<void>((resolve) => {
          const u = new Utterance(clause);
          u.voice = voice;
          u.lang = voice.lang;
          u.rate = settings.rate;
          u.pitch = settings.pitch;
          u.volume = settings.volume;
          u.onend = () => resolve();
          u.onerror = () => resolve();
          synth.speak(u);
        });
      const run = async () => {
        // The system queues utterances itself; each clause is handed over as soon as it is
        // complete, and the last one's end is the end of speech.
        let last: Promise<void> = Promise.resolve();
        try {
          for await (const clause of clauses(text)) {
            if (stopped) break;
            last = speakOne(clause);
          }
          if (!stopped) await last;
        } finally {
          sayOptions.signal?.removeEventListener("abort", stop);
        }
      };
      return { done: run(), lost: settings.lost, stop };
    },
  };
}
