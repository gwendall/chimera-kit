import { VoiceModel } from "./model";
import type { GridSample, HumanArtic, HumanFrame, Vec } from "./types";

export const ARTIC_KEYS = [
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
] as const;
const OUTLINES = [
  "outer",
  "inner",
  "tongue",
  "velum",
  "upperLip",
  "lowerLip",
  "upperTeeth",
  "lowerTeeth",
  "jawBone",
  "epiglottis",
  "nasalCavity",
] as const;

export interface AnatomySnapshot {
  model: VoiceModel;
  artic: HumanArtic;
  frame: HumanFrame;
}

/** Decode the versioned optional suffix without interpreting phoneme labels or guessing geometry. */
export function anatomySnapshot(state: Float32Array | null): AnatomySnapshot | null {
  if (!state || state.length < 6) return null;
  const sections = [state[3] ?? 0, state[4] ?? 0, state[5] ?? 0];
  if (sections.some((n) => !Number.isInteger(n) || n < 1 || n > 4096)) return null;
  const base = 6 + 2 * sections.reduce((n, x) => n + x, 0);
  const d = state.subarray(base);
  if (d.length < 49 || d[0] !== 1 || d[1] !== 1) return null;
  if (!d.every(Number.isFinite)) return null;
  const counts = Array.from(d.subarray(23, 35));
  if (counts.some((n) => !Number.isInteger(n) || n < 1 || n > 4096)) return null;
  const pointCounts = counts.slice(0, 11);
  const gridCount = counts[11] ?? 0;
  if (d.length !== 49 + 2 * pointCounts.reduce((n, x) => n + x, 0) + 11 * gridCount) return null;
  const body = {
    name: "Current voice",
    scale: d[19] ?? 0,
    pharynx: d[20] ?? 0,
    tongueRadius: d[21] ?? 0,
    lipWidth: d[22] ?? 0,
  };
  if (Math.min(body.scale, body.pharynx, body.tongueRadius, body.lipWidth) <= 0) return null;
  const artic = Object.fromEntries(ARTIC_KEYS.map((key, i) => [key, d[2 + i]])) as unknown as HumanArtic;
  let at = 49;
  const point = (): Vec => ({ x: d[at++] ?? 0, y: d[at++] ?? 0 });
  const outlines = Object.fromEntries(
    OUTLINES.map((key, i) => [key, Array.from({ length: pointCounts[i] ?? 0 }, point)]),
  ) as Pick<HumanFrame, (typeof OUTLINES)[number]>;
  const grid: GridSample[] = Array.from({ length: gridCount }, () => ({
    inner: point(),
    outer: point(),
    mid: point(),
    d: d[at++] ?? 0,
    area: d[at++] ?? 0,
    s: d[at++] ?? 0,
    region: (d[at++] ?? 0) as GridSample["region"],
    ray: d[at++] ?? 0,
  }));
  const frame: HumanFrame = {
    ...outlines,
    grid,
    glottis: { x: d[35] ?? 0, y: d[36] ?? 0 },
    length: d[37] ?? 0,
    pharynxLength: d[38] ?? 0,
    teethS: d[39] ?? 0,
    lipS: d[40] ?? 0,
    velumPort: d[41] ?? 0,
    lipArea: d[42] ?? 0,
    tongueCenter: { x: d[43] ?? 0, y: d[44] ?? 0 },
    tongueRadius: d[45] ?? 0,
    tip: { x: d[46] ?? 0, y: d[47] ?? 0 },
    splitIndex: d[48] ?? -1,
  };
  return { model: new VoiceModel(body, sections[0] ?? 0, sections[1] ?? 0), artic, frame };
}
