/** Phrase-owned physical takes with the same audible player as continuous performances. */

import type { EnsembleOptions } from "./ensemble.js";
import { prepareGain } from "./ensemble-gain.js";
import { type Ensemble, EnsemblePlayer } from "./ensemble-player.js";
import { createSequencePool, type SequencePart } from "./sequence-pool.js";

export type { PhysicalClip, SequencePart } from "./sequence-pool.js";

export async function createSequenceEnsemble(
  parts: SequencePart[],
  options: EnsembleOptions = {},
): Promise<Ensemble> {
  if (!parts.length || parts.some((p) => p.duration !== parts[0]?.duration))
    throw new Error("sequence: parts need one shared duration");
  const duration = parts[0]?.duration ?? 0,
    ahead = options.ahead ?? 2;
  if (!Number.isFinite(ahead) || ahead < 0.5 || ahead > 8)
    throw new Error("sequence: ahead must be0.5..8 seconds");
  for (const p of parts) prepareGain(p.gain ?? 1, p.gainCurve, duration);
  const context = options.context ?? new AudioContext({ latencyHint: "playback" });
  let player: EnsemblePlayer | undefined;
  try {
    const pool = await createSequencePool(parts, options);
    try {
      player = new EnsemblePlayer(
        context,
        pool,
        parts,
        duration,
        ahead,
        options.destination ?? context.destination,
        !options.context,
      );
    } catch (error) {
      pool.free();
      throw error;
    }
    await player.warmup();
    return player;
  } catch (error) {
    player?.free();
    if (!options.context && context.state !== "closed") await context.close().catch(() => {});
    throw error;
  }
}
