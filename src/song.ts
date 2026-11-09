/**
 * What every backend does with a song the same way, whether it sings it or can only speak its
 * lyrics: the same refusals, so a call that one backend refuses is refused by all of them.
 */
import type { Song } from "./layers.js";

/** A song, as opposed to text or pieces of text. */
export function isSong(input: unknown): input is Song {
  return typeof input === "object" && input !== null && "notes" in input;
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

/** A song's lyrics as plain text, for a backend that can only speak them: "twin-kle ~" is "twinkle". */
export function spokenLyrics(song: Song): string {
  return song.lyrics
    .replace(/(?<=\S)-(?=\S)/g, "")
    .replace(/(^|\s)[-~](?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** What a backend that only speaks a song's lyrics loses of it. */
export function unsung(song: Song): string[] {
  const lost = ["notes"];
  if (song.vibrato) lost.push("vibrato");
  if (song.t0 !== undefined) lost.push("t0");
  return lost;
}
