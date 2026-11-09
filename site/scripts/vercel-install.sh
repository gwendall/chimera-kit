#!/bin/bash
# The site imports the built library, and the library's engine is Rust compiled to wasm.
# Vercel's image comes with rustup at /rust/bin; the toolchain rust-toolchain.toml pins is installed here.
# This is the install step, not the build step: Vercel looks for next in node_modules right after it.
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! command -v rustup > /dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
  . "$HOME/.cargo/env"
fi
rustup toolchain install
bun install --frozen-lockfile
bun run build
cd site
bun install --frozen-lockfile
