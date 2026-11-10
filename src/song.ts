/**
 * Song and score recognition and timing validation for Chimera voices.
 */
import type { Score, Song } from "./layers.js";

/** A song, as opposed to text or pieces of text. */
export function isSong(input: unknown): input is Song {
  return typeof input === "object" && input !== null && "notes" in input;
}

/** A score, as opposed to text or a song. */
export function isScore(input: unknown): input is Score {
  return typeof input === "object" && input !== null && "sounds" in input;
}

/** A song or a score sets its own rate and pitch: asking for them is an error, not a loss. */
export function refuseTiming(
  what: string,
  options?: { rate?: unknown; f0?: unknown; accent?: unknown },
): void {
  const refused = (["rate", "f0", "accent"] as const).filter((key) => options?.[key] !== undefined);
  if (refused.length > 0) {
    throw new RangeError(
      `intone: ${what} ignores ${refused.join(", ")}; transform it instead (stretch, shift, deliver)`,
    );
  }
}
