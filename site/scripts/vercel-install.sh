#!/bin/bash
# The site imports the built library, and the library's engine is Rust compiled to wasm.
# Vercel's image has bun but no Rust, so install the toolchain rust-toolchain.toml pins.
# This is the install step, not the build step: Vercel looks for next in node_modules right after it.
set -euo pipefail
cd "$(dirname "$0")/../.."
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
. "$HOME/.cargo/env"
rustup toolchain install
bun install --frozen-lockfile
bun run build
cd site
bun install --frozen-lockfile
