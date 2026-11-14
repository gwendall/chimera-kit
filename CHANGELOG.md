# Changelog

## 0.2.0 - 2026-11-14

- Render prepared Chimera gestures with native source controls, sample-timed source events and
  physical telemetry, without dictionary loading or phonetic replanning.
- Share a compiled module across bounded Workers; allocate voices lazily and group mutually
  exclusive phrases by performer.
- Restore exact physical history from local checkpoints or checksummed portable states, including
  gzip assets verified against the decompressed binary SHA256.
- Play continuous ensembles and phrase-owned sequences on one audible clock, with heard telemetry,
  explicit gain stages, gain curves, pause, seek and bounded readiness warmup.
- Accept a prepared `initialState` for a sequence's silent pose without allocating a throwaway
  native voice. This telemetry seed does not replace an acoustic checkpoint.
- Keep distribution generic and Chimera-only. Qualified CI tarballs can be attached to a public
  GitHub release separately from npm authentication; publication remains a separate step.

The API remains pre-1.0. Voice capacity depends on the device, plan density, scene and routing;
short synthetic regression runs do not qualify every full concert or browser.
