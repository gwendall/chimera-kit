/**
 * Every e2e threshold in one file, in the spirit of `eval/budget.ts`: raising one needs a measured
 * reason in a comment next to it. Real-time numbers on this machine move with other agents' load;
 * each one here was measured with `uptime` and the busy-work yardstick recorded next to it in
 * `e2e/out/report.json`, and is set with headroom over what was measured, not at the measured
 * value itself.
 */

export const THRESHOLDS = {
  load: {
    // Measured cold in chromium, 2026-11-09, load average ~3-5 (other agents' evals running):
    // createVoice ~45-70 ms (wasm fetch + compile + dictionary fetch + gunzip). eval/budget.ts's
    // own COLD_START_LIMIT_MS (150 ms) is in Bun, with no fetch/gunzip; a browser adds both.
    coldCreateVoiceMs: 300,
    cachedCreateVoiceMs: 250,
    // Chromium CDP throttling (fast4g ~9Mbps/40ms, slow3g ~400kbps/400ms): the engine+dictionary
    // are small (~1.1 MB together), so even slow3g should land well under a few seconds.
    throttledCreateVoiceMs: 6000,
    cpuThrottledCreateVoiceMs: 1200,
    firstSampleMs: 50,
    firstAudibleMs: 80,
    // index.js + the engine + the dictionary, uncompressed over the route-intercepted "network":
    // README's own gzipped figures sum to about 1.1 MB; local files aren't gzip-encoded in transit
    // here (only cmudict.txt.gz is gzip as a file), so this is intentionally looser than the README
    // table, which is post-gzip. Measured 2026-11-09: chimera.wasm (556,042 B) +
    // cmudict.txt.gz (868,793 B) alone already sum to 1,424,835 B, before a single byte of JS; the
    // full cold load measured 1,450,672 B, stable across three separate runs. The previous
    // 1,400,000 B threshold was below that unavoidable wasm+dictionary floor and could never pass
    // here - not a regression, a miscalculated threshold. Set with real headroom above the floor.
    // Prepared-performance ABI adds 36,647 raw wasm bytes. PR24 cold load measures
    // 1,632,492 B (2026-11-14), while the separate compressed wasm budget remains 290 KB.
    // This gate counts decoded response bodies, including the already-compressed dictionary.
    bytesTransferred: 1_675_000,
  },
  reliability: {
    // A render() call allocates a Float32Array and frees its utterance when done; some retained
    // growth over thousands of calls is expected from the JS engine's own bookkeeping, not
    // evidence of a leak by itself. This is a coarse tripwire, not a precise leak detector.
    heapGrowthPerCallBytes: 2000,
    // 300 create/free cycles: the last 10 must not run meaningfully slower than the first 10.
    createFreeDriftRatio: 1.5,
  },
  polyphony: {
    // Real-time factor ceiling for "this N holds real time": wall-clock time to finish playing
    // must not exceed 1.15x the audio's own duration. Looser than 1.0 because this machine is
    // shared and scheduling jitter is real; a mode that needs more than 15% slack is not holding
    // real time in any useful sense either.
    realTimeFactorCeiling: 1.15,
  },
  install: {
    // Measured: npm pack produced a 1.24 MB tarball (49 files) on 2026-11-09.
    tarballBytes: 2_000_000,
    // npm/pnpm/bun installing a single tarball with zero runtime dependencies, on this machine's
    // network. Generous because registry latency, not chimera-kit's size, dominates this number.
    installMs: 60_000,
    installedBytes: 5_000_000,
    // chimera-kit declares zero regular dependencies (two optional peers); a clean install of the
    // tarball alone should add chimera-kit itself and nothing else.
    depCount: 3,
    // Next.js/Vite install + build in a from-scratch temp project: registry fetches dominate.
    frameworkBuildMs: 120_000,
    bundleBuildMs: 30_000,
  },
  mobile: {
    createVoiceMs: 600,
    firstAudibleMs: 300,
  },
  site: {
    readyMs: 5000,
  },
} as const;
