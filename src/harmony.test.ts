import { describe, expect, test } from "bun:test";
import { harmony, keyOf } from "./harmony.ts";
import { createVoice } from "./index.ts";
import type { Song } from "./layers.ts";
import { melody } from "./melody.ts";

/** An original tune in C, ending on the tonic. */
const tune: Song = {
  lyrics: "sun-light on the wa-ter ~",
  notes: melody("C4:1 D4:1 E4:1 G4:1 A4:1 G4:1 C4:2"),
  bpm: 120,
  vibrato: 30,
  t0: 0.5,
};
const pitches = (song: Song) => song.notes.map((note) => note.midi);

describe("harmony", () => {
  test("a diatonic third above stays in the key: major or minor as the scale has it", () => {
    // C-E is major (4), D-F minor (3), E-G minor (3), G-B major (4), A-C minor (3).
    expect(pitches(harmony(tune, "third-above"))).toEqual([64, 65, 67, 71, 72, 71, 64]);
  });

  test("a diatonic third below", () => {
    expect(pitches(harmony(tune, "third-below"))).toEqual([57, 59, 60, 64, 65, 64, 57]);
  });

  test("octaves and the fifth move in strict parallel", () => {
    expect(pitches(harmony(tune, "octave-below"))).toEqual(pitches(tune).map((m) => m - 12));
    expect(pitches(harmony(tune, "octave-above"))).toEqual(pitches(tune).map((m) => m + 12));
    expect(pitches(harmony(tune, "fifth-below"))).toEqual(pitches(tune).map((m) => m - 7));
  });

  test("keeps the lyrics, rhythm, tempo, vibrato and t0, and leaves the song alone", () => {
    const before = structuredClone(tune);
    const part = harmony(tune, "third-above");
    expect(part.notes.map((note) => note.beats)).toEqual(tune.notes.map((note) => note.beats));
    expect({ ...part, notes: [] }).toEqual({ ...tune, notes: [] });
    expect(tune).toEqual(before);
  });

  test("a given key changes the thirds: B in C is natural, in F it is flat", () => {
    const line: Song = { ...tune, lyrics: "la", notes: melody("G4:1") };
    expect(pitches(harmony(line, "third-above", { key: "C" }))).toEqual([71]);
    expect(pitches(harmony(line, "third-above", { key: "F" }))).toEqual([70]);
  });

  test("a minor key is written as itself and sounds as its relative major's notes", () => {
    const a = pitches(harmony(tune, "third-above", { key: "A minor" }));
    expect(a).toEqual(pitches(harmony(tune, "third-above", { key: "C" })));
    expect(a).toEqual(pitches(harmony(tune, "third-above", { key: "Am" })));
  });

  test("a note outside the key keeps its distance from the key note below it", () => {
    const line: Song = { ...tune, notes: melody("C4:4 C#4:1") };
    // C# is one semitone above C, whose third in C is E: so F, one above E.
    expect(pitches(harmony(line, "third-above", { key: "C" }))).toEqual([64, 65]);
  });

  test("a microtonal note keeps its offset", () => {
    const line: Song = { ...tune, notes: [{ midi: 60.5, beats: 1 }] };
    expect(pitches(harmony(line, "third-above", { key: "C" }))).toEqual([64.5]);
  });

  test("refuses a bad key, a bad part, an empty melody, and notes pushed off the range", () => {
    expect(() => harmony(tune, "third-above", { key: "H" })).toThrow(/not a key/);
    expect(() => harmony(tune, "tenth" as never)).toThrow(/no part named/);
    expect(() => harmony({ ...tune, notes: [] }, "third-above")).toThrow(/at least one/);
    expect(() => harmony({ ...tune, notes: [{ midi: 5, beats: 1 }] }, "octave-below")).toThrow(/range/);
    expect(() => harmony({ ...tune, notes: [{ midi: 120, beats: 1 }] }, "octave-above")).toThrow(/range/);
  });
});

describe("keyOf", () => {
  test("finds the key from the notes and how long they last", () => {
    expect(keyOf(tune.notes)).toBe("C");
    expect(keyOf(melody("G4 A4 B4 C5 D5 F#5:2 G5:2"))).toBe("G");
    expect(keyOf(melody("Eb4 F4 G4 Ab4 Bb4 C5 D5 Eb5:2"))).toBe("Eb");
  });

  test("the ending decides between keys that cover the notes equally", () => {
    // Every note here is in both C and G: it ends on G's tonic, so G.
    expect(keyOf(melody("D4 E4 A4 B4 G4:2"))).toBe("G");
    expect(keyOf(melody("D4 E4 A4 B4 C4:2"))).toBe("C");
  });

  test("a minor melody comes back as its relative major", () => {
    expect(keyOf(melody("A3 B3 C4 D4 E4 F4 G4 A4:2"))).toBe("C");
  });

  test("refuses an empty melody", () => {
    expect(() => keyOf([])).toThrow(/at least one/);
  });
});

describe("a harmony on the real engine", () => {
  test("lasts exactly as long as the melody, so that the voices stay together", async () => {
    const wasm = new URL("../dist/chimera.wasm", import.meta.url);
    const dictionary = new URL("../dist/cmudict.txt.gz", import.meta.url);
    const voice = await createVoice({ wasm, dictionary });
    const lead = voice.render(tune);
    for (const part of ["third-above", "octave-below", "fifth-below"] as const) {
      expect(voice.render(harmony(tune, part)).audio.length).toBe(lead.audio.length);
    }
    voice.free();
  });
});
