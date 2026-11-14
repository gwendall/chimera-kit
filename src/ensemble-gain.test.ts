import { expect, test } from "bun:test";
import { gainAt, prepareGain } from "./ensemble-gain.js";

test("mix automation interpolates the heard position after a seek and keeps its endpoints", () => {
  const c = prepareGain(
    0.5,
    [
      [1, 0],
      [3, 2],
      [5, 1],
    ],
    10,
  );
  expect(gainAt(c, 0)).toBe(0);
  expect(gainAt(c, 2)).toBe(0.5);
  expect(gainAt(c, 4)).toBe(0.75);
  expect(gainAt(c, 8)).toBe(0.5);
  expect(gainAt(prepareGain(0.3, undefined, 10), 8)).toBe(0.3);
  expect(() =>
    prepareGain(
      1,
      [
        [2, 1],
        [1, 1],
      ],
      10,
    ),
  ).toThrow("increasing");
  expect(() => prepareGain(1, [[1, NaN]], 10)).toThrow("multipliers");
});
