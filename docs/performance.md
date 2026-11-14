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
