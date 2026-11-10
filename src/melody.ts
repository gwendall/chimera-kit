import type { Note } from "./layers.js";

const NAMED = /^([A-Ga-g])([#b]?)(-?\d+)$/;
const NUMBERED = /^\d+(\.\d+)?$/;
const BEATS = /^(\d+\.?\d*|\.\d+)$/;
const REST = /^(r|rest|_|-|~)$/i;

/** Semitones above C, within one octave. */
const STEPS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** One written pitch as a MIDI number (C4 is 60, A4 is 69), or undefined if it isn't one. */
function pitchOf(written: string): number | undefined {
  if (NUMBERED.test(written)) return Number(written);
  const named = NAMED.exec(written);
  if (!named) return undefined;
  const [, letter, accidental, octave] = named as unknown as [string, string, string, string];
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return 12 * (Number(octave) + 1) + (STEPS[letter.toLowerCase()] as number) + shift;
}

/**
 * A melody written as text, for people and language models: `"C4:1 D#4:0.5 Bb3:2"`, each note a
 * pitch and its length in beats. The length defaults to one beat, a pitch can be a MIDI number
 * (`60:1`), and `|` between notes is ignored, so a melody can be written in bars.
 *
 * A song has one note per syllable and no silent ones, so a rest is refused rather than dropped,
 * which would shift every later syllable onto the wrong note.
 */
export function melody(text: string): Note[] {
  const notes: Note[] = [];
  for (const token of text.split(/\s+/)) {
    if (token === "" || token === "|") continue;
    const [written = "", beats, extra] = token.split(":");
    if (REST.test(written)) {
      throw new RangeError(
        `chimera-kit: "${token}" is a rest, and a song has none: lengthen the note before it`,
      );
    }
    const midi = pitchOf(written);
    if (midi === undefined || extra !== undefined) {
      throw new RangeError(`chimera-kit: "${token}" is not a note: write it like C4:1, Bb3:0.5 or 60:2`);
    }
    if (midi < 0 || midi > 127) {
      throw new RangeError(`chimera-kit: "${token}" is outside the MIDI range, C-1 to G9`);
    }
    if (beats !== undefined && (!BEATS.test(beats) || Number(beats) <= 0)) {
      throw new RangeError(`chimera-kit: "${token}" needs a length above 0, in beats, like C4:0.5`);
    }
    notes.push({ midi, beats: beats === undefined ? 1 : Number(beats) });
  }
  if (notes.length === 0) throw new RangeError("chimera-kit: a melody needs at least one note");
  return notes;
}
