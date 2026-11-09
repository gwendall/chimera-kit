//! CHIMERA's non-human creatures (songbird, seal, alligator, elephant) behind a small C ABI.
//!
//! This crate does no I/O: it only wraps `chimera::creatures::CreatureVoice` for the browser,
//! under the same real-time contract as `crates/chimera` itself (no allocation while rendering,
//! output independent of block size). `cargo test` exercises that contract for every call of
//! every creature; `crates/chimera` is upstream's and is never edited here.

pub mod abi;

/// Every creature voice renders at this rate, whatever the audio device uses.
pub const SAMPLE_RATE: f64 = 48_000.0;
