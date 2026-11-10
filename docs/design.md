# Design

This package is a JavaScript toolkit dedicated to CHIMERA. It makes the physical voice model
usable in browser applications: speech, singing, live articulation, beatbox, creatures and
playback-time anatomy. No synthesis-provider selector or alternate voice engine is part of the product.

## Public interface

- `createVoice` loads Chimera on the calling thread. It plans text and songs into scores,
  renders whole utterances or yields chunks, and exposes actual airway state on request.
- `createWorkerVoice` uses the same engine and options in a worker. Its `say` method sends
  samples directly to the audio thread and returns an interruptible playback handle.
- `play` handles synchronous or asynchronous chunks, an optional audio context and cancellation.
- `take`, `deliver` and pure score transforms control individual words, timing, pitch,
  loudness, breath and tension without depending on rendering internals.
- `singing` supplies melody notation, harmony and pitch gestures. A song uses the same score
  and rendering path as speech.
- `live` owns a held voice and beat sequencer in an AudioWorklet. Its messages expose
  Chimera's own articulation and source parameters.
- `creatures` loads Chimera's non-human airways in a separate small WASM artifact.
- `tools` validates and serializes language-model calls against a voice's `say` method.
- `imitate` measures a coarse voice profile from a recording with the speaker's agreement.

There is one synthesis engine. Its physical controls are first-class; no public capability
matrix, unsupported-control list or fallback to another engine is needed.

## Plain data, exact rendering

Text and songs become a `Score`: timed sounds, pitch/loudness/breath/tension curves and word
spans. Transforms return another score. Rendering a score honors its timing and pitch, so
text-only options (`rate`, `f0`, `accent`) are refused with an existing score or song.

Bodies are named presets or continuous anatomical/source settings. A seed deterministically
draws a body. Neither a body nor a measured profile is a neural voice clone.

The private `engine.ts` contract separates rendering from the TypeScript facade and provides a
test surface. It is not an extension mechanism for third-party synthesis providers. The Rust
engine comes from upstream; wrapper-specific code stays in `crates/intone-chimera`.

## Playback and ownership

Load a voice once and reuse it. Start audio from a user gesture, or unlock a context before
awaiting a response. Every playback exposes `queued`, `done` and `stop`; stopping must silence
audio already queued and terminate further generation. Free a voice once its playback finishes.
Free live instruments and creatures on teardown.

Workers carry delivery settings as plain data because score-transform functions cannot cross
`postMessage`. Streaming answers are cut into clauses, Markdown is read as words, and sentence
pauses are preserved. Calls from model tools run serially and return validation failures as data.

## Visual state

The optional airway callback retains its tube/pressure prefix and appends a versioned frame of
the actual articulation and geometry. Viewers follow the audio clock, not text guesses or the
render-ahead cursor. The site mounts its canonical Chimera renderer only while visible and
keeps consumed trace history bounded. Reading telemetry must not change audio samples.

## Budgets and attribution

Speech and the live instrument share one WASM binary; creatures load separately. Importing a
feature should carry only the code that feature needs. Size and latency budgets live in
`eval/budget.ts`; deterministic, block-independent rendering is enforced by engine tests.

CHIMERA is by Jameson Hodge. Preserve engine, dictionary, font and vendored-renderer notices
and distinguish this integration toolkit from upstream. No recordings of real people or
copyrighted songs ship in the package.
