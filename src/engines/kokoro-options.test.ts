import { describe, expect, test } from "bun:test";
import {
  isKokoroDevice,
  isKokoroDtype,
  type KokoroDevice,
  type KokoroDtype,
  resolveSpeed,
  validateDevice,
  validateDtype,
} from "./kokoro-options.ts";

const DTYPES: KokoroDtype[] = ["fp32", "fp16", "q8", "q4", "q4f16"];
const DEVICES: KokoroDevice[] = ["wasm", "webgpu", "cpu"];

describe("validateDtype", () => {
  test("defaults to q8", () => {
    expect(validateDtype(undefined)).toBe("q8");
  });
  test("accepts every documented dtype", () => {
    for (const d of DTYPES) expect(validateDtype(d)).toBe(d);
  });
  test("rejects an unknown dtype", () => {
    expect(() => validateDtype("int8")).toThrow("dtype");
  });
});

describe("validateDevice", () => {
  test("undefined and null both mean 'let the library choose'", () => {
    expect(validateDevice(undefined)).toBeUndefined();
    expect(validateDevice(null)).toBeUndefined();
  });
  test("accepts every documented device", () => {
    for (const d of DEVICES) expect(validateDevice(d)).toBe(d);
  });
  test("rejects an unknown device", () => {
    expect(() => validateDevice("gpu")).toThrow("device");
  });
});

describe("resolveSpeed", () => {
  test("defaults to 1", () => {
    expect(resolveSpeed(undefined)).toBe(1);
  });
  test("passes through a valid rate", () => {
    expect(resolveSpeed(1.5)).toBe(1.5);
  });
  test("rejects zero, negative, non-finite and too-fast rates", () => {
    expect(() => resolveSpeed(0)).toThrow("rate");
    expect(() => resolveSpeed(-1)).toThrow("rate");
    expect(() => resolveSpeed(Number.NaN)).toThrow("rate");
    expect(() => resolveSpeed(Number.POSITIVE_INFINITY)).toThrow("rate");
    expect(() => resolveSpeed(4.01)).toThrow("rate");
  });
  test("rejects a non-number", () => {
    expect(() => resolveSpeed("fast")).toThrow("rate");
  });
});

describe("type guards", () => {
  test("isKokoroDtype/isKokoroDevice narrow without throwing", () => {
    expect(isKokoroDtype("q8")).toBe(true);
    expect(isKokoroDtype("nope")).toBe(false);
    expect(isKokoroDevice("cpu")).toBe(true);
    expect(isKokoroDevice("nope")).toBe(false);
  });
});
