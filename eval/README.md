# Evaluation

Is the speech understood, and does the package stay small and cheap?

```sh
bun run build
bun eval/run.ts --name my-change --against eval/baselines/current.json
bun eval/budget.ts
```

`run.ts` renders the corpus through `dist/`, the code that would ship, with two bodies. Two speech
recognizers transcribe it and the word errors are counted. It needs macOS for Whisper through MLX,
and [uv](https://docs.astral.sh/uv/). Parakeet comes from `PARAKEET_DIR`, from Handy's copy, or
is downloaded. Rendering and recognition are deterministic, so a run needs no repeats.

## What it can and can't tell

A word error rate says whether a machine recovered the words. It doesn't say that people find the
voice pleasant, nor that requested pitch and timing were honored, and recognizers don't hear the
way people do. Listen to the renders regularly: a change that only pleases the recognizers is a
failure the numbers can't see.

The defenses against fooling ourselves:

- **Two recognizers** of different architectures. Parakeet TDT 0.6b v3 is the loop's score and
  Whisper large-v3-turbo is the referee. A gain must not cost the other one.
- **Unpredictable sentences**, so that a language model can't fill in words it did not hear.
- **Splits.** `dev` may be read word by word. `held` gives aggregate numbers only, and its
  transcripts are never written to disk. `locked` is for rare, deliberate checks.
- **A paired bootstrap** over the sentences, so that a lucky sentence isn't an improvement.
- **A positive control**: `--control Samantha` renders with macOS `say`, which shows the harness's
  own floor.

## The rules for tuning

1. Change one thing, with a reason. Work from `report.json`'s `dev` transcripts only.
2. `run.ts --against` prints a decision. **KEEP** needs the first recognizer better on `dev` and
   no split of any recognizer worse. Anything else is reverted.
3. Never edit the corpus, the scoring or a recognizer's settings to raise a score. A real change
   to them bumps `JUDGE_VERSION` and needs new baselines.
4. Don't run `--splits locked` during a tuning loop.
5. Record a kept change as a new baseline in `eval/baselines/` with what it changed.
6. Record a reverted one below, so that nobody runs it again without a new reason.

## Tried, not kept

- **Presence boost** (2026-11-09, run `presence3`): a +3 dB peaking filter at 1.6 kHz (Q 0.7)
  on the rendered audio. NO CLEAR CHANGE: Parakeet dev 42.62 -> 43.35 % (interval -0.96 to
  2.33), Whisper dev 22.83 -> 22.94 %. The recognizers don't miss loudness in that band.
