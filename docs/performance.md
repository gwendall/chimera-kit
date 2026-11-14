# Prepared physical performances

`chimera-kit/performance` renders compiled Chimera gestures without a dictionary or a new
phonetic plan. Use it when a preparation pipeline already measured timing, articulation, source
controls and pitch. `Score` remains the higher-level interface for IPA and expression curves.

```ts
import { createPerformanceRenderer } from "chimera-kit/performance";

const renderer = await createPerformanceRenderer(prepared);
try {
  while (true) {
    const samples = renderer.next(4096);
    if (!samples) break;
    consume(samples); // Borrowed view: copy before retaining or transferring it.
  }
} finally {
  renderer.free();
}
```

The version 1 format contains `sampleRate: 48000`, `duration`, optional `body` and `source`,
and native `gestures`. Each gesture keeps its native seconds, ramps, strength, targets, speed,
release hold and label. The renderer applies raw engine output, with no speech gain correction,
no resampling and no implicit tail beyond duration. Supply the exact native source settings.

One physical voice lives from sample zero to the declared end. One-second scheduling windows
retain original blend summation order and the final gesture through rests. Total plan length
can exceed 16384 gestures; a single active scheduling window must still fit that capacity.
Overdense windows fail explicitly rather than dropping controls. Original tags are reserved
internally for scheduling order; this prepared interface does not expose live gesture release.

`telemetry()` describes the rendered position. Playback can be ahead of what a listener hears:
store snapshots by their sample position and select them using the audible transport clock.
`compilePerformance()` produces a reusable WebAssembly module that can cross to Workers.
Run synthesis off the graphics thread; a shared AudioContext alone does not parallelize DSP.

The native regression test compares windowed output with an unsplit plan byte for byte, using
out-of-order overlapping ramps and arbitrary render chunk sizes. A second test schedules a
20000-gesture plan without exhausting the live score. Browser playback deadlines and maximum
simultaneous voices require separate measurements on the target device.

## Parallel voices

`createPerformancePool` from `chimera-kit/performance-pool` shares one compiled wasm module
across a bounded pool of Workers. Pass independent `{ id, performance }` parts, then request
`pool.read(id)` for at most 4800 samples. Each voice retains its physical state; a Worker may
own several voices. Output includes the block's sample range and physical snapshots at 60 Hz.
Only one read may be pending per voice, so callers cannot create an unbounded synthesis queue.
Call `pool.free()` when finished; it terminates owned Workers and rejects outstanding requests.

The default reserves two logical cores and uses at most eight Workers. This is a starting
budget, not a device capacity guarantee. Measure sustained playback alongside rendering.

## Exact seek state

`renderer.checkpoint()` retains the current physical state, including airway waves, glottis,
random state, articulation dynamics and scheduling cursor. `renderer.restore(sample)` restores
the nearest checkpoint at or before that sample, or keeps a more recent current position when
it is already suitable. Render the remaining interval to reach the exact requested position.
This preserves acoustic history; starting a fresh voice at the target time does not.

At most 65 checkpoints are retained, with sample zero always available. Static gesture plans
are stored once. Saving checkpoints allocates and must happen between synthesis requests,
never in an AudioWorklet callback. A position not yet generated requires forward synthesis;
show preparation progress rather than claiming an instantaneous seek.

The pool saves checkpoints every five generated seconds. `pool.seek(id, sample, progress)`
restores and advances on the owning Worker, yielding during long forward preparation. Its
progress uses rendered sample positions. Reads and seeks for the same voice are mutually
exclusive. A slow but progressing seek keeps its request alive; a stalled Worker times out.

## One ensemble transport

`createEnsemble(parts, options)` from `chimera-kit/ensemble` adds a common audible transport to
the pool. All parts declare the same duration. `play`, `pause`, `seek`, `time`, `state` and
`subscribe` control it; `outputs` exposes one independently routed GainNode per part. The
browser synthesizes samples in Workers, then schedules bounded native AudioBuffers on one
AudioContext clock. Its audio device handles sample-rate conversion. No file-audio input is used.

Two seconds of synthesis lookahead is the default, bounded to eight; recent audio and physical
frames are retained for two seconds behind playback. `telemetry(id)` selects the latest
physical frame at or before the audible clock, rather than showing an ahead-of-time pose.
The context's output timestamp accounts for device latency when available. `state.underruns`
counts blocks that missed their scheduling deadline; it must remain zero for qualification.
An over-capacity device can miss deadlines: the counter does not imply every device is fast enough.

Call `play()` from a user gesture and handle its promise. A seek pauses all parts, restores
physical history, then resumes if previously playing. `state.preparing` exposes this work.
Call `free()` when leaving the concert; it clears the timer, sources, Workers and owned context.
A caller-provided context remains owned by the caller. The CI ensemble scenario checks six
real browser voices, heard telemetry, zero late blocks, pause stability and exact seek time.

`sourceEvents: [{ at, source }]` changes pressure, tension and other source controls at the
rounded native sample for `at` seconds. It keeps the same airway and vibration state, and
checkpoints include its event cursor. Times must increase within duration. Gestures still
carry pitch, articulation and breath timing independently. Non-finite controls and unknown
source/target names fail before JSON encoding, preventing NaN-to-null or silently ignored keys.

Each ensemble part may carry a `gainCurve` of increasing `[seconds, multiplier]` points.
Interpolation is linear, with endpoint holds, multiplied by the part's static gain. Playback
reschedules the curve from the sought position; heard telemetry scales output RMS by the same
curve. Native pressure remains a separate physical control. The transport owns output-node
gain automation; route the node to spatial/capture buses rather than overriding its AudioParam.

Pool plans are stored as data until their first read or seek; dormant phrases do not allocate
native voices. Assign `workerGroup` to place mutually exclusive phrases of one performer on
the same Worker. Worker count is bounded by group count and the requested core budget.
`pool.release(id)` drops a native instance while retaining its plan; reading it again starts
at sample zero. This is an explicit phrase lifecycle operation, not a chunk boundary reset.

## Prepared physical checkpoints

For fast first-time seeks, enable `captureState` in `createPerformanceRenderer` and await
`renderer.exportState()` at reviewed sample positions. The result contains changed memory pages
against the fresh deterministic instance, rather than duplicating the static gesture plan.
`createPerformanceRenderer(performance, { state })` restores it before rendering begins.
The next samples are identical to an uninterrupted renderer, including waves and random state.

States are application data tied to the exact wasm SHA256, input/base-memory hash, ABI, sample
count and native handles. Bounds, page order and a whole-payload SHA256 are checked before any
memory changes. Regenerate states when the engine or performance changes. Compilation records
the module identity; a caller supplying an already-transferred `module` must also pass its
verified `engineId` when importing or exporting state. Store checkpoints outside the package,
with the prepared performance's own integrity manifest.

Capture retains a base-memory copy and is intended for preparation. Normal playback does not
retain that copy. Use the direct renderer when preparing portable states; adding many local
`checkpoint()` clones would unnecessarily enlarge exported memory differences. The browser
regression restores a Bun-generated state and requires bit-identical continuation samples.

## Owned native takes

`createSequenceEnsemble` from `chimera-kit/sequence` reuses the same audible player for prepared
phrase ownership. Each part declares duration and non-overlapping clips. A clip has its original
PhysicalPerformance, integer `startSample`/`endSample` on the output clock, `sourceSample` on the
native clock, explicit phrase/continuous intent and optional ordered float32 gain stages and
prepared checkpoints. Warmup belongs to the native source; only the owned interval is heard.
No file audio enters the sequence. Gaps are silent and native state is released at take changes.

Keep connected syllables and ornaments inside their original take. Short owned intervals below
200 ms require `shortEvent.evidence`, including a gain-only boundary within the same exact source.
Ownership overlap and insufficient source coverage fail rather than summing or padding voices.
The regression compares placed samples with direct warmed native output, including gain rounding,
gaps and seeking; a real browser scenario checks six phrase-owned parts on the common clock.
