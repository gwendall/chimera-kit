# Contributing

You need [Bun](https://bun.sh) and [rustup](https://rustup.rs). `rust-toolchain.toml` picks the
compiler. The evaluation also needs [uv](https://docs.astral.sh/uv/) and a Mac.

```sh
bun install
bun run build
bun run test
bun run typecheck
bun run lint
bun run budget
```

A change to the sound comes with an evaluation against the current baseline: see
[eval/README.md](eval/README.md). The engine in `crates/chimera` comes from
[upstream](https://github.com/jamesondh/chimera-vocal-synth): engine improvements usually belong
there first. [AGENTS.md](AGENTS.md) has the rules of the repository.
