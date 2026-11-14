/** Playback gain belongs to the mix, independently of native source pressure and articulation. */
export type GainPoint = [seconds: number, multiplier: number];
export interface GainControl {
  base: number;
  curve: GainPoint[];
}

export function prepareGain(base: number, points: GainPoint[] | undefined, duration: number): GainControl {
  if (!Number.isFinite(base) || base < 0 || base > 4) throw new Error("ensemble: gain must be 0..4");
  let previous = -1;
  for (const [at, value] of points ?? []) {
    if (
      !Number.isFinite(at) ||
      at < 0 ||
      at > duration ||
      at <= previous ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 4
    )
      throw new Error("ensemble: gain curve needs increasing times and multipliers 0..4");
    previous = at;
  }
  return { base, curve: points?.map(([at, value]) => [at, value]) ?? [] };
}

export function gainAt(control: GainControl, time: number): number {
  const points = control.curve;
  if (!points.length) return control.base;
  let low = 0,
    high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((points[mid]?.[0] ?? Infinity) <= time) low = mid + 1;
    else high = mid;
  }
  const b = points[low],
    a = points[Math.max(0, low - 1)];
  if (!a) return control.base;
  if (!b || b[0] === a[0]) return control.base * a[1];
  const fraction = Math.max(0, Math.min(1, (time - a[0]) / (b[0] - a[0])));
  return control.base * (a[1] + fraction * (b[1] - a[1]));
}

export function scheduleGain(param: AudioParam, control: GainControl, origin: number, start: number): void {
  param.cancelScheduledValues(0);
  param.setValueAtTime(gainAt(control, origin), start);
  for (const [at, value] of control.curve)
    if (at > origin) param.linearRampToValueAtTime(control.base * value, start + at - origin);
}
