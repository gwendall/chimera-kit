import { expect, test } from "bun:test";
import {
  RESUME_FIRST,
  STALL_LOW,
  STALL_MARGIN,
  canResume,
  mustStall,
  resumeTarget,
  stallPosition,
} from "./ensemble-buffering.js";

test("the clock stops before it passes the rendered audio, never at the end of the piece", () => {
  expect(mustStall(10, 10 + STALL_LOW + 0.01, 60)).toBe(false);
  expect(mustStall(10, 10 + STALL_LOW - 0.01, 60)).toBe(true);
  // Already starved (a throttled timer): still a stall, never a silent clock running on.
  expect(mustStall(10, 9, 60)).toBe(true);
  // The last block of the piece is rendered: nothing left to wait for.
  expect(mustStall(59.9, 60, 60)).toBe(false);
});

test("every part stops on one position just ahead of the heard time and within the rendered audio", () => {
  expect(stallPosition(10, 10.2)).toBeCloseTo(10 + STALL_MARGIN, 12);
  expect(stallPosition(10, 10.01)).toBe(10.01);
  expect(stallPosition(10, 9)).toBe(10);
});

test("resuming waits for the warmup's worth of audio, longer after each stall, bounded by the lookahead", () => {
  expect(resumeTarget(1, 2)).toBe(RESUME_FIRST);
  expect(resumeTarget(2, 2)).toBe(RESUME_FIRST * 2);
  expect(resumeTarget(3, 2)).toBe(1.9);
  expect(resumeTarget(9, 8)).toBe(7.6);
  expect(canResume(10, 10 + RESUME_FIRST - 0.01, 60, RESUME_FIRST)).toBe(false);
  expect(canResume(10, 10 + RESUME_FIRST, 60, RESUME_FIRST)).toBe(true);
  expect(canResume(59.5, 60, 60, RESUME_FIRST)).toBe(true);
});
