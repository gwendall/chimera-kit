/**
 * When synthesis falls behind the heard clock, the transport waits for sound instead of dropping it.
 * An over-capacity device (too few cores, a busy scene, a cold start) used to schedule every late
 * block in the past, drop it, and never catch up: permanent silence while the clock went on. These
 * pure rules decide when the clock stops at a rendered position and when it starts again.
 */

/** Stop the clock when less than this is rendered past the heard time (seconds). */
export const STALL_LOW = 0.3;
/** Stop this far ahead of the heard time, so every source can stop on one sample. */
export const STALL_MARGIN = 0.03;
/** Rendered seconds past the stop before the first resume; the cold start warms up as much. */
export const RESUME_FIRST = 0.8;

/** Each later stall waits twice as long, up to what the lookahead lets synthesis render. */
export function resumeTarget(stalls: number, ahead: number): number {
  return Math.min(ahead * 0.95, RESUME_FIRST * 2 ** Math.max(0, stalls - 1));
}

/** True when playback must stop: the heard time is about to pass the slowest part's rendered end. */
export function mustStall(time: number, rendered: number, duration: number): boolean {
  return rendered < duration && rendered - time < STALL_LOW;
}

/** The common position every part stops at: just ahead of the heard time, never past the rendered audio. */
export function stallPosition(time: number, rendered: number): number {
  return Math.max(time, Math.min(rendered, time + STALL_MARGIN));
}

/** True when enough is rendered past the stop, or the rest of the piece is. */
export function canResume(stoppedAt: number, rendered: number, duration: number, target: number): boolean {
  return rendered >= duration || rendered - stoppedAt >= target;
}
