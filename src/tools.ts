/**
 * `intone/tools`: lets a language model drive a voice through tool calls. The definitions are
 * plain JSON Schema, the same schema validates each call, and a bad call comes back as a result
 * the model can read and correct instead of an exception, as a model repairs its own arguments
 * when told what was wrong with them.
 *
 * Works on anything with the `say` of a worker voice or a speaker, whichever engine is behind it.
 * A separate entry so that an app that only speaks ships none of it.
 */
import { MOODS, type Mood } from "./delivery.js";
import type { Body } from "./engine.js";
import type { Song } from "./layers.js";
import { melody } from "./melody.js";

export { melody } from "./melody.js";

interface Field {
  type: "string" | "number";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
}

/** A tool as a language model is told about it, in JSON Schema. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, Field>;
    required: string[];
    additionalProperties: false;
  };
}

const MOOD: Field = {
  type: "string",
  enum: Object.keys(MOODS),
  description: "The emotional color of the delivery.",
};
const INTENSITY: Field = {
  type: "number",
  minimum: 0,
  maximum: 2,
  description: "How far to take the mood: 0 is neutral, 1 as written (the default), 2 doubled.",
};
const RATE: Field = {
  type: "number",
  exclusiveMinimum: 0,
  maximum: 4,
  description: "Speaking-rate multiplier: 1 is normal, 1.2 faster, 0.8 slower.",
};

function tool(
  name: string,
  description: string,
  properties: Record<string, Field>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  };
}

const SAY = tool(
  "say",
  "Speak text aloud. The result arrives when the speech has finished.",
  {
    text: { type: "string", minLength: 1, description: "What to say, in plain English." },
    mood: MOOD,
    intensity: INTENSITY,
    rate: RATE,
  },
  ["text"],
);

const SING = tool(
  "sing",
  "Sing lyrics on a melody aloud, one note per syllable. The result arrives when the song has finished.",
  {
    lyrics: {
      type: "string",
      minLength: 1,
      description:
        'The words, with hyphens between the syllables of a word ("sun-light on the wa-ter"). A lone ~ between spaces holds the previous vowel through one more note. There must be exactly as many syllables, counting each ~, as notes.',
    },
    melody: {
      type: "string",
      minLength: 1,
      description:
        'The notes, separated by spaces, each a pitch and its length in beats: "C4:1 D#4:0.5 Bb3:2". C4 is middle C. A | between notes is ignored, so bars can be marked. There are no rests: lengthen the note before instead.',
    },
    bpm: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 400,
      description: "Tempo in beats per minute.",
    },
    vibrato: {
      type: "number",
      minimum: 0,
      maximum: 400,
      description: "Vibrato depth on held vowels, in cents. 0 for none, 40 is gentle.",
    },
    mood: MOOD,
    intensity: INTENSITY,
  },
  ["lyrics", "melody", "bpm"],
);

const SET_VOICE = tool(
  "set_voice",
  "Change how the voice sounds from now on. Anything left out goes back to its default, so calling this with nothing resets the voice.",
  {
    body: { type: "string", enum: ["male", "female", "child"], description: "The speaker's body." },
    f0: {
      type: "number",
      minimum: 20,
      maximum: 2000,
      description: "Baseline pitch of speech in Hz, typically 90 to 300. Songs follow their notes instead.",
    },
    rate: RATE,
    mood: MOOD,
    intensity: INTENSITY,
  },
);

/** The tools, in a neutral shape. `forAnthropic` and `forOpenAI` turn them into each API's. */
export const TOOLS: readonly ToolDefinition[] = [SAY, SING, SET_VOICE];

/** For the `tools` of Anthropic's Messages API. */
export function forAnthropic(tools: readonly ToolDefinition[] = TOOLS) {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters,
  }));
}

/** For the `tools` of OpenAI's Chat Completions API. */
export function forOpenAI(tools: readonly ToolDefinition[] = TOOLS) {
  return tools.map(({ name, description, parameters }) => ({
    type: "function" as const,
    function: { name, description, parameters },
  }));
}

/** The voice a runner speaks with. Every field is optional; absent means the backend's default. */
export interface VoiceSettings {
  body?: Extract<Body, string>;
  f0?: number;
  rate?: number;
  mood?: Mood;
  intensity?: number;
}

interface SayArguments {
  text: string;
  mood?: Mood;
  intensity?: number;
  rate?: number;
}

interface SingArguments {
  lyrics: string;
  melody: string;
  bpm: number;
  vibrato?: number;
  mood?: Mood;
  intensity?: number;
}

/** Options a runner passes to `say`: data only, so they suit a worker and every backend. */
export interface ToolSayOptions {
  body?: Extract<Body, string>;
  f0?: number;
  rate?: number;
  delivery?: Mood;
  intensity?: number;
}

/** What a runner needs of a voice: a worker voice and a speaker both fit. */
export interface ToolTarget {
  say(
    input: string | Song,
    options?: ToolSayOptions,
  ): { queued: Promise<unknown>; done: Promise<unknown>; stop(): void; lost?: string[] | undefined };
}

/** A tool call's outcome, ready for `JSON.stringify` and the model. */
export type ToolResult =
  | {
      ok: true;
      /** What the backend could not do of this call, such as `notes` on one that cannot sing. */
      lost?: string[];
      /** Stopped before the end, by `stop`. */
      interrupted?: true;
      /** The voice now in effect, after `set_voice`. */
      voice?: VoiceSettings;
    }
  | { ok: false; error: string };

export interface ToolRunner {
  /**
   * Carries out one tool call and never rejects: a bad call resolves to `{ ok: false, error }`, to
   * hand back to the model. Calls speak one after the other in the order they were made, so a
   * model that asks for several at once isn't heard talking over itself.
   */
  run(name: string, input: unknown): Promise<ToolResult>;
  /** Silences the voice and drops the calls still waiting, as when the user interrupts. */
  stop(): void;
}

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^intone: /, "");
}

/** Refuses anything its schema doesn't allow, and returns the arguments without nulls. */
function checked(definition: ToolDefinition, input: unknown): Record<string, unknown> {
  const { name, parameters } = definition;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${name} takes an object of named arguments`);
  }
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    // Some models send null for an optional argument they mean to leave out.
    if (value === null || value === undefined) continue;
    if (!Object.hasOwn(parameters.properties, key)) {
      const known = Object.keys(parameters.properties).join(", ");
      throw new TypeError(`${name} has no argument "${key}"; it takes ${known}`);
    }
    refuseValue(key, value, parameters.properties[key] as Field);
    args[key] = value;
  }
  for (const key of parameters.required) {
    if (args[key] === undefined) throw new TypeError(`${name} needs "${key}"`);
  }
  return args;
}

function refuseValue(key: string, value: unknown, field: Field): void {
  if (field.type === "string") {
    if (typeof value !== "string") throw new TypeError(`"${key}" must be a string`);
    if (field.minLength !== undefined && value.trim().length < field.minLength) {
      throw new RangeError(`"${key}" must not be empty`);
    }
    if (field.enum && !field.enum.includes(value)) {
      throw new RangeError(`"${key}" must be one of ${field.enum.join(", ")}; got "${value}"`);
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`"${key}" must be a number`);
  }
  const { minimum, maximum, exclusiveMinimum } = field;
  if (
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum) ||
    (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
  ) {
    const low = exclusiveMinimum !== undefined ? `above ${exclusiveMinimum}` : `from ${minimum}`;
    throw new RangeError(`"${key}" must be ${low} up to ${maximum}; got ${value}`);
  }
}

/** Fields that may be explicitly undefined. */
type Loose<T> = { [K in keyof T]: T[K] | undefined };

/** Without the absent fields, so that a backend sees only what the call asked for. */
function present<T extends object>(options: Loose<T>): T {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Carries out a model's tool calls on a voice. `defaults` is the voice `set_voice` goes back to.
 *
 * ```ts
 * const tools = createToolRunner(await createSpeaker());
 * // for each tool call in the model's reply:
 * const result = await tools.run(call.name, call.input);
 * ```
 */
export function createToolRunner(target: ToolTarget, defaults: VoiceSettings = {}): ToolRunner {
  const initial = checked(SET_VOICE, defaults) as VoiceSettings;
  let settings = initial;
  let tail: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let current: { stop(): void } | undefined;

  const speak = (input: string | Song, options: Loose<ToolSayOptions>): Promise<ToolResult> => {
    const asked = generation;
    const result = tail.then(async (): Promise<ToolResult> => {
      if (asked !== generation) return { ok: false, error: "stopped before it started" };
      try {
        const playback = target.say(input, present<ToolSayOptions>(options));
        current = playback;
        await Promise.all([playback.queued, playback.done]);
        return {
          ok: true,
          lost: playback.lost ?? [],
          ...(asked === generation ? {} : { interrupted: true as const }),
        };
      } catch (error) {
        return { ok: false, error: reason(error) };
      } finally {
        current = undefined;
      }
    });
    tail = result;
    return result;
  };

  const say = (args: SayArguments) =>
    speak(args.text, {
      body: settings.body,
      f0: settings.f0,
      rate: args.rate ?? settings.rate,
      delivery: args.mood ?? settings.mood,
      intensity: args.intensity ?? settings.intensity,
    });

  // No rate and no f0: a song's notes set them, and it refuses both.
  const sing = (args: SingArguments) =>
    speak(
      present<Song>({
        lyrics: args.lyrics,
        notes: melody(args.melody),
        bpm: args.bpm,
        vibrato: args.vibrato,
      }),
      {
        body: settings.body,
        delivery: args.mood ?? settings.mood,
        intensity: args.intensity ?? settings.intensity,
      },
    );

  return {
    async run(name, input) {
      try {
        switch (name) {
          case SAY.name:
            return await say(checked(SAY, input) as unknown as SayArguments);
          case SING.name:
            return await sing(checked(SING, input) as unknown as SingArguments);
          case SET_VOICE.name:
            settings = { ...initial, ...checked(SET_VOICE, input ?? {}) };
            return { ok: true, voice: settings };
          default:
            return {
              ok: false,
              error: `no tool named "${name}"; there are ${TOOLS.map((t) => t.name).join(", ")}`,
            };
        }
      } catch (error) {
        return { ok: false, error: reason(error) };
      }
    },
    stop() {
      generation += 1;
      current?.stop();
    },
  };
}
