/**
 * Option validation for the Kokoro voice, kept free of `kokoro-js` so it can be tested without
 * the model download. `KokoroTTS` validates `voice` itself (`_validate_voice`, a clear error
 * naming every voice it knows); this file only validates what would otherwise fail deep inside
 * the model or silently produce the wrong thing.
 */

/** `KokoroTTS.from_pretrained`'s own union, copied here so a typo is a compile error. */
export type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
const DTYPES: ReadonlySet<string> = new Set(["fp32", "fp16", "q8", "q4", "q4f16"]);

export type KokoroDevice = "wasm" | "webgpu" | "cpu";
const DEVICES: ReadonlySet<string> = new Set(["wasm", "webgpu", "cpu"]);

/** Speaking-rate multiplier above which Kokoro's own prosody (trained at 1x) audibly breaks up. */
const MAX_RATE = 4;

export function isKokoroDtype(value: unknown): value is KokoroDtype {
  return typeof value === "string" && DTYPES.has(value);
}

export function isKokoroDevice(value: unknown): value is KokoroDevice {
  return typeof value === "string" && DEVICES.has(value);
}

export function validateDtype(dtype: unknown): KokoroDtype {
  if (dtype === undefined) return "q8";
  if (!isKokoroDtype(dtype)) {
    throw new RangeError(
      `intone/kokoro: dtype must be one of ${[...DTYPES].join(", ")}, got ${String(dtype)}`,
    );
  }
  return dtype;
}

export function validateDevice(device: unknown): KokoroDevice | undefined {
  if (device === undefined || device === null) return undefined;
  if (!isKokoroDevice(device)) {
    throw new RangeError(
      `intone/kokoro: device must be one of ${[...DEVICES].join(", ")}, got ${String(device)}`,
    );
  }
  return device;
}

/** `rate` (intone's own option name) to Kokoro's `speed`: the same number, just validated. */
export function resolveSpeed(rate: unknown): number {
  const speed = rate ?? 1;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed > MAX_RATE) {
    throw new RangeError(
      `intone/kokoro: rate must be a number > 0 and at most ${MAX_RATE}, got ${String(speed)}`,
    );
  }
  return speed;
}
