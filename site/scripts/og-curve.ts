// The share card draws the real pitch of the page's first example, plain and with one word stressed:
// "stole", the middle of the sentence, so it survives a square crop of the card.
// Regenerate after a change to the planner: `bun run sync && bun scripts/og-curve.ts`.
import { writeFileSync } from "node:fs";
import { createVoice, take } from "../lib/intone/index.js";

const voice = await createVoice({ body: "female" });
const plain = voice.plan("I never said she stole my money.");
const STRESS = "stole";
const t = take(plain);
t.word(STRESS).emphasize();
const stressed = t.score;

// The planner gives a point every 10 ms: about 230 points a curve, rounded to keep the file small.
// Each reading keeps its own word timings: a stressed word lasts longer and pushes the rest later.
const reading = (score: typeof plain) => ({
  words: (score.words ?? []).map((w) => ({
    text: w.text,
    t0: Number(w.t0.toFixed(3)),
    t1: Number(w.t1.toFixed(3)),
  })),
  pitch: score.pitch.map(([time, hz]) => [Number(time.toFixed(3)), Number(hz.toFixed(1))]),
});
const curve = { stress: STRESS, plain: reading(plain), stressed: reading(stressed) };
writeFileSync(new URL("../assets/og-curve.generated.json", import.meta.url), `${JSON.stringify(curve)}\n`);
console.log(
  `og-curve: ${curve.stressed.words.length} words, ${curve.plain.pitch.length} + ${curve.stressed.pitch.length} points`,
);
