/**
 * `intone/singing`: pure helpers for songs. A melody written as text, a harmony line for a second
 * voice, and the pitch ornaments of a sung line, as score transforms. A separate entry so that an
 * app that only speaks ships none of it.
 */
import type { Curve, Sound } from "./layers.js";
import { type ScoreTransform, valueAt } from "./transforms.js";

export { harmony, keyOf, type Part } from "./harmony.js";
export { melody } from "./melody.js";

/** Spacing of the points added where the pitch bends (s), that of a sung score's own curve. */
const STEP = 0.01;
const VOWEL = /^[aeiouæɑɒɛɪɔʊʌəɝɚɜ]/;
const SILENCE = "_";

const isVowel = (sound: Sound | undefined) => sound !== undefined && VOWEL.test(sound.sound);

function refuse(name: string, semitones: number, seconds: number): void {
  if (!(Number.isFinite(semitones) && semitones > 0)) {
    throw new RangeError(`intone: ${name} needs a depth above 0 semitones, got ${semitones}`);
  }
  if (!(Number.isFinite(seconds) && seconds > 0)) {
    throw new RangeError(`intone: ${name} needs a length above 0 seconds, got ${seconds}`);
  }
}

/**
 * The curve with `semitones(t)` added to it from `t0` to `t1`. A point just outside each end keeps
 * the bend from leaking along a sparse curve, as a line to the next far-off point would carry it.
 */
function bend(pitch: Curve, t0: number, t1: number, semitones: (t: number) => number): Curve {
  const times = new Set(pitch.map(([t]) => t));
  for (let t = t0; t < t1; t += STEP) times.add(t);
  times.add(t1);
  const first = (pitch[0] as [number, number])[0];
  const last = (pitch[pitch.length - 1] as [number, number])[0];
  if (t0 - STEP > first) times.add(t0 - STEP);
  if (t1 + STEP < last) times.add(t1 + STEP);
  return [...times]
    .sort((a, b) => a - b)
    .map((t): [number, number] => {
      const value = valueAt(pitch, t) as number;
      return [t, t >= t0 && t <= t1 ? value * 2 ** (semitones(t) / 12) : value];
    });
}

/**
 * Starts each note below its pitch and slides up into it, as singers do. Applies to a vowel that
 * begins a syllable: a held note (`~`) continues its vowel and takes no new attack. The slide
 * takes at most half of the vowel.
 */
export function scoop(semitones = 1, seconds = 0.09): ScoreTransform {
  refuse("scoop", semitones, seconds);
  return (score, scope) => {
    if (score.pitch.length === 0) return score;
    let pitch = score.pitch;
    score.sounds.forEach((sound, index) => {
      if (!isVowel(sound) || isVowel(score.sounds[index - 1])) return;
      if (scope && (sound.t0 < scope.t0 || sound.t0 >= scope.t1)) return;
      const end = sound.t0 + Math.min(seconds, (sound.t1 - sound.t0) / 2);
      const span = end - sound.t0;
      pitch = bend(pitch, sound.t0, end, (t) => -semitones * (1 - (t - sound.t0) / span) ** 2);
    });
    return { ...score, pitch };
  };
}

/**
 * Lets the pitch drop off the last vowel before each silence and at the end, as a phrase is let
 * go. The drop stays down through any consonants left in the phrase, which would otherwise jump
 * back up. The slide takes at most the whole vowel.
 */
export function fall(semitones = 3, seconds = 0.25): ScoreTransform {
  refuse("fall", semitones, seconds);
  return (score, scope) => {
    if (score.pitch.length === 0) return score;
    let pitch = score.pitch;
    let phraseEnd = score.duration;
    let spoken = false;
    for (let index = score.sounds.length - 1; index >= 0; index -= 1) {
      const sound = score.sounds[index] as Sound;
      if (sound.sound === SILENCE) {
        phraseEnd = sound.t0;
        spoken = false;
      } else if (isVowel(sound) && !spoken) {
        spoken = true;
        if (scope && (sound.t1 <= scope.t0 || sound.t1 > scope.t1)) continue;
        const start = Math.max(sound.t0, sound.t1 - seconds);
        const span = sound.t1 - start;
        pitch = bend(pitch, start, phraseEnd, (t) => -semitones * Math.min(1, (t - start) / span) ** 2);
      }
    }
    return { ...score, pitch };
  };
}
