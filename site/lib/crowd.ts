// What a crowd says, as plain timelines: who speaks what, and when. Everything is original text.
import type { Body, Mood, Song } from "./intone/index.js";

export type Scene = "hubbub" | "choir" | "dialogue";

export interface Turn {
  voice: number;
  at: number;
  say: string | Song;
  body: Body;
  f0?: number;
  rate?: number;
  delivery?: Mood;
  intensity?: number;
}

const LINES = [
  "Did you leave the door open again?",
  "I think the train is running late.",
  "Nobody told me about the meeting.",
  "That is the best soup I have had all week.",
  "Can you hear me over all of this?",
  "We should have turned left at the bridge.",
  "My sister painted that one herself.",
  "It was raining when we got there.",
  "Tell him I will call back after lunch.",
  "Who ordered the extra coffee?",
  "I found your keys under the table.",
  "They said it would be ready by Friday.",
  "You never told me you could dance.",
  "There is a dog asleep on the stairs.",
  "Let me see the other one first.",
  "We ran out of time at the end.",
];

const TALK = [
  "So what do we do now?",
  "We wait for the others.",
  "How long will that take?",
  "Not long, they are on their way.",
  "Did anyone bring something to eat?",
  "I brought apples and some bread.",
  "Then I am staying right here.",
  "Good, because here they come.",
];

const MOODS: Mood[] = ["neutral", "calm", "excited", "sad", "angry", "whisper"];

const words = (line: string) => line.split(" ").length;

/** A body of its own for every voice: the same index always gives the same person. */
function person(i: number): Pick<Turn, "body" | "f0" | "rate"> {
  const r = (seed: number) => {
    const x = Math.sin((i + 1) * seed) * 43758.5453;
    return x - Math.floor(x);
  };
  const kind = r(12.9898);
  const female = kind < 0.42 ? r(4.1) * 0.25 : kind < 0.86 ? 0.75 + r(4.1) * 0.25 : 0.5;
  const child = kind >= 0.86 ? 0.55 + r(7.3) * 0.45 : 0;
  const base = child ? 250 : female > 0.5 ? 190 : 112;
  return {
    body: { female, child },
    f0: Math.round(base * (0.85 + r(2.7) * 0.32)),
    rate: Number((0.9 + r(9.2) * 0.3).toFixed(2)),
  };
}

// A short tune in four parts, written for this page: soprano, alto, tenor, bass.
const CHOIR_LYRICS = "No-bo-dy taught us how to sing, we on-ly have a tube of air.";
const CHOIR_BEATS = [1, 0.5, 0.5, 1, 0.5, 0.5, 1, 2, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, 2];
const PARTS = [
  [62, 64, 66, 69, 67, 66, 64, 62, 66, 67, 69, 74, 73, 69, 67, 69],
  [57, 61, 62, 66, 62, 62, 61, 57, 62, 62, 66, 69, 69, 66, 62, 66],
  [54, 57, 57, 62, 59, 57, 57, 54, 57, 59, 62, 66, 64, 62, 59, 62],
  [50, 45, 50, 54, 55, 50, 45, 50, 50, 55, 54, 50, 45, 50, 55, 50],
];
const PART_BODY: Body[] = [
  { female: 1, child: 0 },
  { female: 0.85, child: 0.15 },
  { female: 0.2, child: 0 },
  { female: 0, child: 0 },
];

function hubbub(n: number): Turn[] {
  const turns: Turn[] = [];
  for (let voice = 0; voice < n; voice++) {
    const who = person(voice);
    const mood = MOODS[voice % MOODS.length] as Mood;
    let at = ((voice * 0.37) % 1) * 0.9;
    let line = voice * 5;
    while (at < 11) {
      const say = LINES[line % LINES.length] as string;
      turns.push({ voice, at, say, ...who, delivery: mood, intensity: 0.7 });
      at += words(say) * 0.36 + 0.7 + ((line * 0.61) % 1) * 1;
      line += 3;
    }
  }
  return turns;
}

function choir(n: number): Turn[] {
  return Array.from({ length: n }, (_, voice) => {
    const part = voice % PARTS.length;
    const notes = (PARTS[part] as number[]).map((midi, i) => ({ midi, beats: CHOIR_BEATS[i] ?? 1 }));
    return {
      voice,
      at: ((voice * 0.37) % 1) * 0.03,
      say: { lyrics: CHOIR_LYRICS, notes, bpm: 92, vibrato: 25 + (voice % 5) * 8 },
      body: PART_BODY[part] as Body,
    };
  });
}

function dialogue(n: number): Turn[] {
  let at = 0;
  return TALK.map((say, i) => {
    const turn: Turn = { voice: i % n, at, say, ...person(i % n), delivery: "neutral" };
    at += words(say) * 0.34 + 0.08;
    return turn;
  });
}

export function scene(name: Scene, voices: number): Turn[] {
  if (name === "choir") return choir(voices);
  if (name === "dialogue") return dialogue(voices);
  return hubbub(voices);
}
