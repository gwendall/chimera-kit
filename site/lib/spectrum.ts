// One column of a spectrogram, computed as an AnalyserNode computes it (Blackman window, magnitude
// over N, the same dB range), so a precomputed reading looks exactly like the live one.
export const SPECTRUM_SIZE = 2048;

const window_ = Float32Array.from(
  { length: SPECTRUM_SIZE },
  (_, i) =>
    0.42 -
    0.5 * Math.cos((2 * Math.PI * i) / SPECTRUM_SIZE) +
    0.08 * Math.cos((4 * Math.PI * i) / SPECTRUM_SIZE),
);

const bits = Math.log2(SPECTRUM_SIZE);
const reversed = Uint16Array.from({ length: SPECTRUM_SIZE }, (_, i) => {
  let out = 0;
  for (let b = 0; b < bits; b++) if (i & (1 << b)) out |= 1 << (bits - 1 - b);
  return out;
});

export function spectrumColumn(signal: Float32Array, minDb: number, maxDb: number): Uint8Array {
  const n = SPECTRUM_SIZE;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[reversed[i] as number] = (signal[i] ?? 0) * (window_[i] ?? 0);
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const c = Math.cos(step * k);
        const s = Math.sin(step * k);
        const a = start + k;
        const b = a + half;
        const x = (re[b] ?? 0) * c - (im[b] ?? 0) * s;
        const y = (re[b] ?? 0) * s + (im[b] ?? 0) * c;
        re[b] = (re[a] ?? 0) - x;
        im[b] = (im[a] ?? 0) - y;
        re[a] = (re[a] ?? 0) + x;
        im[a] = (im[a] ?? 0) + y;
      }
    }
  }
  const out = new Uint8Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const magnitude = Math.hypot(re[k] ?? 0, im[k] ?? 0) / n;
    const db = 20 * Math.log10(magnitude || 1e-12);
    out[k] = Math.max(0, Math.min(255, ((db - minDb) / (maxDb - minDb)) * 255));
  }
  return out;
}
