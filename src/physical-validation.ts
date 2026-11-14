/** Refuse silent JSON losses before native planning: NaN becomes null and unknown targets vanish. */
import type { PhysicalPerformance } from "./performance.js";

const SOURCE = new Set([
  "f0",
  "glide",
  "pressure",
  "breathiness",
  "tension",
  "fry",
  "roughness",
  "vibratoDepth",
  "vibratoRate",
  "drift",
  "voiced",
  "brightness",
]);
const TARGET = new Set([
  "jaw",
  "tbX",
  "tbY",
  "ttX",
  "ttY",
  "ttCurl",
  "root",
  "lipAp",
  "lipProt",
  "lipWidth",
  "labiodental",
  "velum",
  "larynx",
  "epilarynx",
  "ventricular",
  "lateral",
  "dorsum",
  "abduction",
  "closure",
  "breath",
  "f0",
  "vibrato",
]);

export function validatePhysical(performance: PhysicalPerformance): void {
  const active = new WeakSet<object>();
  const walk = (value: unknown): void => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("chimera-kit: physical controls must be finite");
    if (value && typeof value === "object") {
      if (active.has(value)) throw new Error("chimera-kit: physical data contains a cycle");
      active.add(value);
      for (const v of Object.values(value)) walk(v);
      active.delete(value);
    }
  };
  walk(performance);
  const source = (patch: object) => {
    for (const [key, value] of Object.entries(patch)) {
      if (!SOURCE.has(key)) throw new Error(`chimera-kit: unknown physical source ${key}`);
      if (value !== undefined && typeof value !== (key === "voiced" ? "boolean" : "number"))
        throw new Error(`chimera-kit: invalid physical source ${key}`);
    }
  };
  if (performance.source) source(performance.source);
  for (const event of performance.sourceEvents ?? []) source(event.source);
  for (const gesture of performance.gestures) {
    for (const [key, value] of Object.entries(gesture.targets)) {
      if (!TARGET.has(key)) throw new Error(`chimera-kit: unknown physical target ${key}`);
      if (value !== undefined && typeof value !== "number")
        throw new Error(`chimera-kit: invalid physical target ${key}`);
    }
  }
}
