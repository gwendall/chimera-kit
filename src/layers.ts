/**
 * The layers a request goes through, as plain data (see docs/design.md). Every value here is
 * JSON: a program can read it, edit it and hand it back.
 */

/** Points of a curve over time: `[seconds, value]`, linear between points, held past the ends. */
export type Curve = [seconds: number, value: number][];

/** One timed sound of a score. */
export interface Sound {
  /** An IPA phone, `"_"` for silence, or a sound the body defines. */
  sound: string;
  /** Start, in seconds from the start of the score. */
  t0: number;
  /** End, in seconds. Sounds don't overlap and are in time order. */
  t1: number;
  /** Lexical stress of a vowel: 0 unstressed, 1 primary, 2 secondary. */
  stress?: 0 | 1 | 2;
}

/** Where a word lies in a score, so that it can be selected by its text. */
export interface WordSpan {
  text: string;
  t0: number;
  t1: number;
}

/**
 * Layer 2: exactly what to sound and when, and how. The layer where timing and pitch are exact,
 * and the layer a test can check by measuring the render.
 */
export interface Score {
  /** Total length in seconds, silence after the last sound included. */
  duration: number;
  sounds: Sound[];
  /** Fundamental frequency in Hz. */
  pitch: Curve;
  /** Level in dB relative to the voice's own. */
  loudness?: Curve;
  /** 0 clean, 1 all air. */
  breath?: Curve;
  /** 0 lax, 1 pressed. Absent, the voice's own (0.5 for CHIMERA's bodies). */
  tension?: Curve;
  /** Vibrato depth in cents, as a sung score has it. Absent, the voice adds none. */
  vibrato?: Curve;
  words?: WordSpan[];
}

/** A note: a MIDI pitch (69 is A4, 440 Hz; a fraction bends it) and a length in beats. */
export interface Note {
  midi: number;
  beats: number;
}

/**
 * Layer 3 for singing: lyrics and the melody they are sung on, one note per syllable. Hyphens
 * split a word's syllables as typed ("twin-kle"), and a lone "-" or "~" between spaces holds the
 * previous vowel through one more note.
 */
export interface Song {
  lyrics: string;
  notes: Note[];
  /** Beats per minute. */
  bpm: number;
  /** Vibrato depth on held vowels, in cents, blooming a quarter second into each hold. Default 0. */
  vibrato?: number;
  /**
   * When the first note's beat falls, in seconds; its consonants come before it. Default: just
   * late enough for them to start at 0. Set it to put the beat on an accompaniment's.
   */
  t0?: number;
}

/** A syllable: its phones in IPA, and its stress. */
export interface Syllable {
  phones: string[];
  stress: 0 | 1 | 2;
}

export interface Word {
  text: string;
  syllables: Syllable[];
  /** 0 plain, 1 strongest. */
  emphasis: number;
}

export type PhraseEnd = "none" | "comma" | "period" | "question" | "exclamation";

export interface Phrase {
  words: Word[];
  end: PhraseEnd;
  /** Seconds of silence after the phrase. */
  pause: number;
}

/** Layer 3: what is said, before any timing. */
export interface Phrasing {
  /** BCP 47 language tag, such as `"en"`. */
  lang: string;
  phrases: Phrase[];
}
