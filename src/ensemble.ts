/** Parallel physical voices on one audible clock, with independent mix outputs. */

import { prepareGain } from "./ensemble-gain.js";
import { type Ensemble, type EnsembleMixPart, EnsemblePlayer } from "./ensemble-player.js";
import {
  createPerformancePool,
  type PerformancePart,
  type PerformancePool,
  type PerformancePoolOptions,
} from "./performance-pool.js";

export type { GainPoint } from "./ensemble-gain.js";
export type { Ensemble, EnsembleState } from "./ensemble-player.js";

export interface EnsemblePart extends PerformancePart, EnsembleMixPart {}
export interface EnsembleOptions extends PerformancePoolOptions {
  context?: AudioContext;
  destination?: AudioNode;
  /** Seconds generated ahead of the listener, in [0.5, 8]. Default 2. */
  ahead?: number;
}

export async function createEnsemble(
  parts: EnsemblePart[],
  options: EnsembleOptions = {},
): Promise<Ensemble> {
  if (!parts.length || parts.some((p) => p.performance.duration !== parts[0]?.performance.duration))
    throw new Error("ensemble: parts need one shared duration");
  if (parts.some((p) => p.gain !== undefined && (!Number.isFinite(p.gain) || p.gain < 0 || p.gain > 4)))
    throw new Error("ensemble: gain must be 0..4");
  for (const p of parts) prepareGain(p.gain ?? 1, p.gainCurve, p.performance.duration);
  const ahead = options.ahead ?? 2;
  if (!Number.isFinite(ahead) || ahead < 0.5 || ahead > 8)
    throw new Error("ensemble: ahead must be 0.5..8 seconds");
  const context = options.context ?? new AudioContext({ latencyHint: "playback" });
  let pool: PerformancePool | undefined;
  try {
    pool = await createPerformancePool(parts, options);
    const player = new EnsemblePlayer(
      context,
      pool,
      parts,
      parts[0]?.performance.duration ?? 0,
      ahead,
      options.destination ?? context.destination,
      !options.context,
    );
    try {
      await player.warmup();
      return player;
    } catch (error) {
      player.free();
      throw error;
    }
  } catch (error) {
    pool?.free();
    if (!options.context && context.state !== "closed") await context.close().catch(() => {});
    throw error;
  }
}
