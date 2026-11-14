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

## Prepared initial telemetry

A `SequencePart` may supply `initialState: LiveTelemetry`, captured from its own prepared native
body. The sequence uses it for silent geometry before an owned take. This avoids creating and
freeing the first native voice merely to obtain a pose. Without it, initialization still obtains
that pose from a temporary renderer. Neither path changes the samples of the owned clips.

Keep all scalar fields finite and restore array fields as `Float32Array` when loading JSON:
`artic`, `pharynxAreas`, `mouthAreas`, `pressureRms`, `flow`, `glottalArea`, `glottalFlow`.
Supply the complete native telemetry record, including nonempty articulation and airway arrays.
The sequence silences its idle f0, voicing, pressure, output RMS, noise and gate, and maps its clock
to the output timeline. An initial telemetry pose contains no acoustic history: it cannot replace
a portable checkpoint, reset an active take or manufacture a valid seek position.

## Portable state assets and gzip

A prepared checkpoint is `{ sample, source, sha256 }`. Samples are strictly increasing integer
positions on the native performance's 48 kHz clock. `source` accepts the same byte or URL inputs
as the Chimera wasm loader. `sha256` is lowercase hex for the **uncompressed state binary**.
The Worker detects gzip bytes and decompresses before hashing and importing. A server may instead
apply HTTP `Content-Encoding: gzip`; already decoded bytes are hashed directly. Renaming a gzip
file does not change the expected logical binary hash.

Keep the exact performance serialization and qualified wasm bytes with their preparation manifest.
Rebuilding wasm from equivalent source does not establish the same module digest. An engine,
input/base-memory or payload mismatch fails rather than using approximate state. Select a prepared
checkpoint at or before the requested source sample, then synthesize the remaining interval on the
Worker. The checkpoint spacing bounds that replay work; it is an application preparation choice,
not an engine promise that an unvisited seek is instantaneous.

The direct renderer exports state asynchronously with `await renderer.exportState()` and accepts
a decoded `Uint8Array` through `{ state }`. Gzip decoding of prepared checkpoint assets belongs to
the Worker path, not that direct option. `captureState: true` retains extra base memory for offline
preparation; normal playback should avoid retaining it. Keep JSON plans, state binaries and their
integrity metadata outside this generic package.

## Sequence clocks and readiness

```ts
import { createSequenceEnsemble, type SequencePart } from "chimera-kit/sequence";

// Each performance is a validated PhysicalPerformance, not an audio file or an asset URL.
const parts: SequencePart[] = [{
  id: "singer",
  duration: 4,
  clips: [{
    performance: prepared,
    startSample: 48000,
    endSample: 144000,
    sourceSample: 12000,
    intent: "phrase",
  }],
}];
const ensemble = await createSequenceEnsemble(parts, { workers: 2, ahead: 2 });
// Call ensemble.play() from a user gesture; call ensemble.free() when leaving playback.
```

The example owns output samples `[48000, 144000)`, taking native samples `[12000, 108000)`.
Its source must cover that interval. Every part uses one shared duration; gaps produce silence.
The SDK takes hydrated `PhysicalPerformance` objects. An application's asset registry, compressed
plan loader and UI telemetry cues are separate from this TypeScript contract.

Gain stages run in order with float32 rounding. `intent: "continuous"` records continuity intent;
it does not infer missing state across different takes. A gain-only split of one take must preserve
its exact source-sample translation. Owned intervals below 9600 samples require explicit
`shortEvent.evidence`; short slices are not a way to bypass native phrase preparation.

Both ensemble factories resolve after bounded warmup of `min(ahead, 0.8)` seconds. They do not
resume the AudioContext until `play()` is called. `state.preparing`, `bufferedSeconds`, `error` and
`underruns` expose readiness and scheduling failures. Repeated concurrent `play()` calls share one
startup operation. Keep the graphics clock aligned to `time()` and heard physical telemetry,
rather than the furthest sample synthesized by a Worker. `free()` is required on every exit path.

## Qualification envelope and limits

| Interface | Enforced bound or regression coverage |
| --- | --- |
| Direct `next()` | Borrowed wasm view, at most 4096 native samples |
| Pool `read()` | At most 4800 samples, one pending read or seek per voice |
| Physical snapshots | Native sample positions at 800-sample intervals, 60 Hz |
| Worker budget | Default at most eight and two logical cores reserved; explicit budget 1..16, capped by group count |
| Active gesture window | At most 16384 gestures; longer total plans use bounded windows |
| Ensemble lookahead | 0.5..8 seconds, default 2; recent audio/frames retained for two seconds |
| Sequence ownership | Integer half-open sample intervals, no overlaps or implicit audio padding |
| Synthetic Worker regression | Three independent voices on two Workers match direct native output sample for sample |
| Browser ensemble/sequence smoke | Six synthetic parts, zero late blocks and pause drift, seek error below one microsecond, heard telemetry lag below 50 ms |

These are implementation bounds and reproducible test checks, not a benchmark promise. The public
browser smoke uses ten-second synthetic plans, six Workers and two seconds of lookahead. It does
not establish the capacity of dense full-length arrangements with a 3D scene, HRTF routing, room
convolution or another CPU workload. See `e2e/scenarios/ensemble.ts`, `sequence.ts` and the existing
native/Worker tests for the actual fixtures. Bun throughput and OfflineAudioContext rendering
measure computation; they do not establish live browser scheduling deadlines. Qualify the exact
package, asset hashes, browser/device, scene and routing, including sustained underrun and memory
measurements. More Workers can compete with graphics or increase memory; measure before raising
the budget.
