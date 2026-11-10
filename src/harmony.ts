import type { Note, Song } from "./layers.js";

/** A second part for the same lyrics and rhythm. */
export type Part = "octave-above" | "octave-below" | "fifth-below" | "third-above" | "third-below";

/** The pitch classes of a major scale above its tonic; its relative minor shares them. */
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
/** Scale degree 6 of a major key is the tonic of the minor key with the same notes. */
const RELATIVE_MINOR = 9;
const NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const LETTERS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** Sharps and flats each major key is written with, to prefer the plainer of two equal keys. */
const ACCIDENTALS = [0, 5, 2, 3, 4, 1, 6, 1, 4, 3, 2, 5];

const pitchClass = (midi: number) => ((Math.round(midi) % 12) + 12) % 12;
const inKey = (tonic: number, pc: number) => MAJOR.includes((pc - tonic + 12) % 12);
const homeOf = (tonic: number, pc: number) => pc === tonic || pc === (tonic + RELATIVE_MINOR) % 12;

/**
 * The tonic of the major key whose notes best cover a melody, weighted by how long each note
 * lasts. A relative minor counts as its major, as they share their notes: A minor comes back as
 * C. Ties go to the key the melody ends, then starts, on, and then to the plainer key signature.
 */
function tonicOf(notes: readonly Note[]): number {
  let best = 0;
  let bestScore = [-1, -1, -1, -99];
  const last = pitchClass((notes[notes.length - 1] as Note).midi);
  const first = pitchClass((notes[0] as Note).midi);
  for (let tonic = 0; tonic < 12; tonic += 1) {
    let covered = 0;
    for (const note of notes) if (inKey(tonic, pitchClass(note.midi))) covered += note.beats;
    const score = [
      covered,
      homeOf(tonic, last) ? 1 : 0,
      homeOf(tonic, first) ? 1 : 0,
      -(ACCIDENTALS[tonic] as number),
    ];
    const better = score.findIndex((value, i) => value !== bestScore[i]);
    if (better >= 0 && (score[better] as number) > (bestScore[better] as number)) {
      best = tonic;
      bestScore = score;
    }
  }
  return best;
}

/** The major key a melody is most likely in, by name: `"G"`, `"Eb"`. A minor key gives its relative. */
export function keyOf(notes: readonly Note[]): string {
  if (notes.length === 0) throw new RangeError("chimera-kit: a melody needs at least one note");
  return NAMES[tonicOf(notes)] as string;
}

/** A key's tonic as a pitch class: "G", "Eb", "F#", or a minor key, "A minor" or "C#m". */
function parseKey(key: string): number {
  const match = /^\s*([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?\s*$/.exec(key);
  if (!match) throw new RangeError(`chimera-kit: "${key}" is not a key: write it like G, Eb or A minor`);
  const [, letter, accidental, quality] = match as unknown as [string, string, string, string?];
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  const tonic = (LETTERS[letter.toLowerCase()] as number) + shift;
  const minor = ["m", "min", "minor"].includes(quality ?? "");
  // A minor key has the notes of the major key three semitones above its tonic.
  return (tonic + (minor ? 3 : 0) + 12) % 12;
}

/**
 * Two scale steps away within the key. A note outside the key keeps its distance from the
 * nearest key note below it, so that a chromatic passing note stays a passing note.
 */
function third(midi: number, tonic: number, direction: 1 | -1): number {
  let base = Math.floor(midi);
  while (!inKey(tonic, pitchClass(base))) base -= 1;
  let target = base;
  for (let steps = 0; steps < 2; steps += 1) {
    target += direction;
    while (!inKey(tonic, pitchClass(target))) target += direction;
  }
  return target + (midi - base);
}

const PARALLEL: Partial<Record<Part, number>> = {
  "octave-above": 12,
  "octave-below": -12,
  "fifth-below": -7,
};

/**
 * A harmony line for a song: the same lyrics and rhythm on other notes, for a second voice to
 * sing. Thirds follow the key, major or minor as the scale has it at each note; octaves and the
 * fifth move in strict parallel. The key is worked out from the melody unless given.
 */
export function harmony(song: Song, part: Part, options: { key?: string } = {}): Song {
  if (song.notes.length === 0) throw new RangeError("chimera-kit: a melody needs at least one note");
  const parallel = PARALLEL[part];
  if (parallel === undefined && part !== "third-above" && part !== "third-below") {
    throw new RangeError(`chimera-kit: no part named "${part}"`);
  }
  const tonic = options.key === undefined ? tonicOf(song.notes) : parseKey(options.key);
  const notes = song.notes.map(({ midi, beats }, index) => {
    const moved =
      parallel !== undefined ? midi + parallel : third(midi, tonic, part === "third-above" ? 1 : -1);
    if (moved < 0 || moved > 127) {
      throw new RangeError(`chimera-kit: ${part} of note ${index} (MIDI ${midi}) falls outside MIDI's range`);
    }
    return { midi: moved, beats };
  });
  return { ...song, notes };
}
