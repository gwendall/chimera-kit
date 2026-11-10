/**
 * A voice of its own for every seed. CHIMERA's voice space is continuous (see `BodySpec`): this
 * draws one point of it from a number or a string, the same point every time, so that each user,
 * agent or character in a chat keeps one voice without anyone choosing a dozen settings.
 */
import type { BodySpec } from "./engine.js";

/**
 * The body for `seed`: the same seed gives the same body on every machine. A number or a string
 * (a name, a user id). The bodies are drawn where the speech evaluation found them as intelligible
 * as the presets (`eval/README.md`); a spec written by hand can go further.
 */
export function bodyFromSeed(seed: number | string): BodySpec {
  if (typeof seed === "number" && !Number.isFinite(seed)) {
    throw new Error(`seed must be a finite number or a string, got ${seed}`);
  }
  const next = random(typeof seed === "string" ? hash(seed) : seed);
  const between = (low: number, high: number, u = next()) => round(low + (high - low) * u);
  // Mostly a man's or a woman's voice, sometimes a child's: the androgynous middle stays reachable
  // by hand, but a seed that lands there every other time sounds like nobody in particular.
  const female = next() < 0.5 ? between(0, 0.3) : between(0.7, 1);
  const child = next() < 0.15 ? between(0.4, 1) : 0;
  // The anatomy stays on the blend's side: the male and female bodies are only 10 to 12 % apart
  // in size and throat, so wider draws made women's blends with men's airways, and the first
  // recognizer dropped their sentences (eval/README.md, "Drawn bodies").
  const size = between(0.96, 1.04);
  return {
    female,
    child,
    size,
    throat: between(0.95, 1.05),
    tongue: between(0.94, 1.06),
    lips: between(0.9, 1.1),
    // A bigger airway goes with a lower voice, loosely.
    pitch: round(between(-3, 3) - 15 * (size - 1)),
    breathiness: between(0.05, 0.4, next() ** 2),
    tension: between(0.35, 0.65),
    brightness: between(0.15, 0.45),
    fry: next() < 0.3 ? between(0, 0.25) : 0,
    roughness: between(0.05, 0.25, next() ** 2),
  };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** mulberry32: small, fast and well spread even from consecutive seeds. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the string's UTF-16 code units. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
