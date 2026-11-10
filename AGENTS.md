# chimera-kit

Text to speech in the browser, from a physical model of the human airway: a small Rust/wasm engine
under a small TypeScript API. Small and cheap to run are the point. Intelligible comes next, and
fine programmatic control of the delivery is what it is for. Natural is not a goal.

## Working here

- Do what was asked, the simplest way. Side work nobody asked for is a proposal with its cost.
- Commit small. The subject names what changed and the trap, in searchable words. The body gives
  the why, what you ruled out, what you ran (with numbers) and what you didn't test.
- Keep each fixed bug's reproduction as a test.
- English everywhere. No em dashes or en dashes anywhere.
- Code outranks this file: fix the file when they disagree.

## Map

- `crates/chimera/`: the engine, **from upstream**. See below.
- `crates/intone-chimera/`: our layer over it (`lib.rs`) and the browser's C ABI (`abi.rs`).
- `src/`: the JavaScript side. `voice.ts` and `engine.ts` know no engine; `engines/chimera.ts` is the adapter.
- `eval/`: the intelligibility harness and the budgets. `eval/README.md` has its rules.
- `docs/design.md`: the layers, voices, transforms and engine interface the API grows into.
- `scripts/sync-upstream.sh`: brings in upstream's engine.

## Rules

- **`crates/chimera` belongs to upstream.** Sync it with `bun run sync-upstream`, which merges in
  three ways. Everything of ours goes in `crates/intone-chimera` when it can. When a change must
  touch the engine, keep it small, in its own commit, and worth proposing upstream.
- **The engine's contract** (upstream's `docs/rust-engine.md`): transcendental math through
  `chimera::math`, no allocation while rendering, output independent of block size.
- **Any engine change moves the sound.** Golden tests fail by design; re-bless with
  `CHIMERA_BLESS=1 cargo test --workspace --no-fail-fast`, run twice. Then run the evaluation.
- **Chimera only.** Public entries expose Chimera speech, scores, singing, live control and creatures.
  Do not add alternate synthesis providers or capability fallbacks. The internal engine contract
  stays private for rendering and tests, not as a public multi-provider interface.
- **The ABI is defined twice**, in `abi.rs` and `src/engines/chimera.ts`. Change both, and bump `ABI_VERSION`
  in both.
- **`bun test` tests `dist/`**, which is a build product: run `bun run build` after a Rust change.
- **Tuning for intelligibility follows `eval/README.md`** and never edits its judges or its corpus.
- **Never read the `held` or `locked` transcripts**, and never write them to disk.
- **Size is a feature.** `eval/budget.ts` holds the limits. A dependency or a table that raises
  them needs a measured reason.
- **Nothing copyrighted goes in git**: no recordings of real speakers, no copied song or show data.

## Checks

| When you touch             | Run                                                                             |
| -------------------------- | ------------------------------------------------------------------------------- |
| anything                   | `bun run test`, `bun run typecheck`, `bun run lint`                             |
| anything shipped           | `bun run budget`                                                                |
| what the voice sounds like | `bun eval/run.ts --name <run> --against eval/baselines/current.json` and listen |
