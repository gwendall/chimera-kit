import type { Scenario } from "../lib/types.ts";
import { runEnsembleProbe } from "./ensemble.ts";
export const scenario: Scenario = {
  id: "sequence",
  description: "Phrase-owned physical voices reuse the audible ensemble transport",
  smoke: true,
  run: (ctx) => runEnsembleProbe(ctx, true),
};
