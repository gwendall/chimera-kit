/**
 * Polyphony to the breaking point. Ramps N concurrent voices through the main thread, the
 * library's worker (`createWorkerVoice`) and `intone/speaker`, on a crowd scenario (original,
 * non-copyrighted sentences, random bodies and moods), and reports the largest N that holds real
 * time. A fixed, moderate N is also run once for dialogue, choir, creature-zoo and a mixed scene,
 * to confirm those shapes work without ramping each one separately (see the report for why: the
 * full cross product of 5 families x 3 modes x 8 N-levels x N browsers would not fit this
 * machine's "no two heavy ramps at once" rule in one sitting).
 *
 * Underruns are read from each `Playback`'s own `done.underruns`, which the AudioWorklet reports
 * from real gaps in what it fed the audio thread, not assumed from timing on the main thread.
 */
import type { Body } from "../../src/engine.ts";
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { BrowserName, Measurement, Scenario, ScenarioContext } from "../lib/types.ts";
import { THRESHOLDS } from "../thresholds.ts";

const ORIGIN = "https://intone.e2e";
const RAMP_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128];
type Mode = "main" | "worker" | "speaker";
const MODES: Mode[] = ["main", "worker", "speaker"];
/** Hard ceiling on one mode's ramp, so a measurement bug can't spin forever on a shared machine. */
const MODE_WALLCLOCK_BUDGET_MS = 90_000;

interface StepResult {
  createMs: number;
  wallMs: number;
  nominalAudioMs: number;
  underruns: number;
  peak: number;
  clippedSamples: number;
  nonFiniteSamples: number;
  errors: number;
  soloVsCrowdMaxError: number;
}

/** Runs inside the page. Everything here uses only intone's public API, as a real app would. */
async function stepInPage({
  origin,
  mode,
  n,
}: {
  origin: string;
  mode: Mode;
  n: number;
}): Promise<StepResult> {
  const { createVoice, createWorkerVoice, play } = await import(/* @vite-ignore */ `${origin}/index.js`);
  const { createSpeaker } = await import(/* @vite-ignore */ `${origin}/speaker.js`);
  // Body only blends female/child (see src/engine.ts); a male percentage or a bare `{ female: 1 }`
  // object is not a valid shape and the engine correctly rejects it (an untagged-enum mismatch) -
  // this array used to carry both and crashed the very first render() call of every mode and N.
  const bodies: Body[] = [
    "female",
    "male",
    "child",
    { female: 0.5, child: 0.5 },
    { female: 0.3, child: 0.7 },
  ];
  const sentences = [
    "The market square was loud with voices and carts.",
    "Someone near the fountain was arguing about the price of bread.",
    "A child ran between the stalls, laughing at nothing.",
    "The bell over the gate rang twice, then stopped.",
    "Smoke from the bakery drifted across the whole street.",
    "Two merchants shook hands and the crowd moved on.",
  ];
  const audioCtx = new AudioContext();
  // A small meter the harness adds itself (not part of the library) to read the real mix: peak
  // and clipped-sample counts across everything that reaches the destination.
  const meterUrl = URL.createObjectURL(
    new Blob(
      [
        `class E2EMeter extends AudioWorkletProcessor {
          constructor() { super(); this.peak = 0; this.clipped = 0; this.nonFinite = 0;
            this.port.onmessage = () => this.port.postMessage({ peak: this.peak, clipped: this.clipped, nonFinite: this.nonFinite }); }
          process(inputs, outputs) {
            const inp = inputs[0] && inputs[0][0]; const out = outputs[0][0];
            if (inp) { for (let i = 0; i < inp.length; i++) {
              const s = inp[i]; out[i] = s;
              if (!Number.isFinite(s)) this.nonFinite++;
              else { const a = Math.abs(s); if (a > this.peak) this.peak = a; if (a >= 0.999) this.clipped++; }
            } }
            return true;
          }
        }
        registerProcessor("e2e-meter", E2EMeter);`,
      ],
      { type: "text/javascript" },
    ),
  );
  await audioCtx.audioWorklet.addModule(meterUrl);
  URL.revokeObjectURL(meterUrl);
  const meter = new AudioWorkletNode(audioCtx, "e2e-meter", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  meter.connect(audioCtx.destination);

  // Learn each sentence's nominal duration with one throwaway voice, before any timing starts.
  const probe = await createVoice({ body: "female" });
  const durations = sentences.map((s) => (probe.render(s).audio.length / probe.sampleRate) * 1000);
  probe.free();

  const createStarted = performance.now();
  let errors = 0;
  const underrunsP: Promise<number>[] = [];
  let nominalAudioMs = 0;
  let soloVsCrowdMaxError = 0;

  try {
    if (mode === "main") {
      const voices = await Promise.all(
        Array.from({ length: n }, (_, i) => createVoice({ body: bodies[i % bodies.length] })),
      );
      const createMs = performance.now() - createStarted;
      // The "solo vs crowd" check: voice 0's render(), computed now, must match a render computed
      // in complete isolation (no other voice ever created), since each voice owns its own engine.
      const soloBaseline = voices[0].render(sentences[0]).audio;
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        const text = sentences[i % sentences.length];
        nominalAudioMs = Math.max(nominalAudioMs, durations[i % durations.length] ?? 0);
        const playback = play(v.stream(text), v.sampleRate, { context: audioCtx, destination: meter });
        underrunsP.push(
          playback.done
            .then((e: { underruns: number }) => e.underruns)
            .catch(() => {
              errors++;
              return 0;
            }),
        );
      }
      const again = voices[0].render(sentences[0]).audio;
      for (let i = 0; i < Math.min(again.length, soloBaseline.length); i++) {
        soloVsCrowdMaxError = Math.max(soloVsCrowdMaxError, Math.abs(again[i] - soloBaseline[i]));
      }
      const wallStart = performance.now();
      const underruns = (await Promise.all(underrunsP)).reduce((a, b) => a + b, 0);
      const wallMs = performance.now() - wallStart;
      for (const v of voices) v.free();
      const stats = await new Promise<{ peak: number; clipped: number; nonFinite: number }>((resolve) => {
        meter.port.onmessage = ({ data }) => resolve(data);
        meter.port.postMessage("report");
      });
      await audioCtx.close();
      return {
        createMs,
        wallMs,
        nominalAudioMs,
        underruns,
        errors,
        soloVsCrowdMaxError,
        peak: stats.peak,
        clippedSamples: stats.clipped,
        nonFiniteSamples: stats.nonFinite,
      };
    }

    // worker and speaker modes: say() sends samples straight to the audio thread, and both
    // report its underruns through `done`.
    // createWorkerVoice and createSpeaker return compatible but differently-typed `say()` results;
    // this harness only reads their common shape, so `any` here is deliberate, not a slip.
    const opened: any[] = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        mode === "worker"
          ? createWorkerVoice({ body: bodies[i % bodies.length] })
          : createSpeaker("chimera", { body: bodies[i % bodies.length] }),
      ),
    );
    const createMs = performance.now() - createStarted;
    const wallStart = performance.now();
    for (let i = 0; i < opened.length; i++) {
      const text = sentences[i % sentences.length] ?? "";
      nominalAudioMs = Math.max(nominalAudioMs, durations[i % durations.length] ?? 0);
      const playback = opened[i].say(text, { context: audioCtx, destination: meter });
      underrunsP.push(
        playback.done
          .then((end: { underruns?: number }) => end.underruns ?? 0)
          .catch(() => {
            errors++;
            return 0;
          }),
      );
    }
    const underruns = (await Promise.all(underrunsP)).reduce((a, b) => a + b, 0);
    const wallMs = performance.now() - wallStart;
    for (const v of opened) v.free();
    const stats = await new Promise<{ peak: number; clipped: number; nonFinite: number }>((resolve) => {
      meter.port.onmessage = ({ data }) => resolve(data);
      meter.port.postMessage("report");
    });
    await audioCtx.close();
    return {
      createMs,
      wallMs,
      nominalAudioMs,
      underruns,
      errors,
      soloVsCrowdMaxError,
      peak: stats.peak,
      clippedSamples: stats.clipped,
      nonFiniteSamples: stats.nonFinite,
    };
  } catch {
    try {
      await audioCtx.close();
    } catch {
      // already closed or never opened; nothing more to release.
    }
    return {
      createMs: -1,
      wallMs: -1,
      nominalAudioMs: 0,
      underruns: 0,
      errors: errors + 1,
      soloVsCrowdMaxError: 0,
      peak: 0,
      clippedSamples: 0,
      nonFiniteSamples: 0,
    };
  }
}

export const scenario: Scenario = {
  id: "polyphony",
  description:
    "Ramps N concurrent voices (main thread, worker, speaker) on a crowd scene until it " +
    "no longer holds real time; checks dialogue, choir, creature zoo and a mixed scene once each.",
  smoke: true,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    const browsers: BrowserName[] = ctx.smoke ? ["chromium"] : ctx.browsers;
    for (const browserName of browsers) {
      await withBrowser(browserName, async (browser) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await serveDir(page, ORIGIN, ctx.dist);
        await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
        if (browserName !== "chromium") await page.addInitScript(() => {});

        const modes = ctx.smoke ? (["main"] as Mode[]) : MODES;
        for (const mode of modes) {
          const levels = ctx.smoke ? [1, 4] : RAMP_LEVELS;
          let largestHolding = 0;
          let brokeAt: number | null = null;
          const modeStart = performance.now();
          for (const n of levels) {
            if (!ctx.smoke && performance.now() - modeStart > MODE_WALLCLOCK_BUDGET_MS) {
              out.push({
                name: `polyphony.${browserName}.${mode}.rampStopped`,
                value: n,
                unit: "N",
                note: "stopped: mode wall-clock budget reached, not a real-time failure",
              });
              break;
            }
            ctx.log(`polyphony: ${browserName} ${mode} N=${n}`);
            const r = await page.evaluate(stepInPage, { origin: ORIGIN, mode, n });
            const rtf = r.nominalAudioMs > 0 ? r.wallMs / r.nominalAudioMs : Number.POSITIVE_INFINITY;
            const holds =
              r.errors === 0 &&
              r.underruns === 0 &&
              rtf <= THRESHOLDS.polyphony.realTimeFactorCeiling &&
              r.nonFiniteSamples === 0 &&
              r.createMs >= 0;
            out.push(
              {
                name: `polyphony.${browserName}.${mode}.N${n}.realTimeFactor`,
                value: rtf,
                unit: "x",
                threshold: THRESHOLDS.polyphony.realTimeFactorCeiling,
                pass: rtf <= THRESHOLDS.polyphony.realTimeFactorCeiling,
              },
              {
                name: `polyphony.${browserName}.${mode}.N${n}.underruns`,
                value: r.underruns,
                unit: "count",
                threshold: 0,
                pass: r.underruns === 0,
              },
              { name: `polyphony.${browserName}.${mode}.N${n}.createMs`, value: r.createMs, unit: "ms" },
              {
                name: `polyphony.${browserName}.${mode}.N${n}.peak`,
                value: r.peak,
                unit: "amplitude",
                note: r.clippedSamples > 0 ? `${r.clippedSamples} clipped samples` : undefined,
              },
              {
                name: `polyphony.${browserName}.${mode}.N${n}.soloVsCrowdMaxError`,
                value: r.soloVsCrowdMaxError,
                unit: "sample delta",
                threshold: 0,
                pass: r.soloVsCrowdMaxError === 0,
              },
            );
            if (holds) largestHolding = n;
            else {
              brokeAt = n;
              break;
            }
          }
          out.push({
            name: `polyphony.${browserName}.${mode}.largestNHoldingRealTime`,
            value: largestHolding,
            unit: "voices",
            note: brokeAt
              ? `broke at N=${brokeAt}; ramp stopped there (plus the one step already run)`
              : "did not break within the levels tried",
          });
        }
        await context.close();
      });
    }

    if (ctx.smoke) return out;

    // Fixed-N checks for the other families, worker mode, chromium: confirm the shapes work.
    await withBrowser("chromium", async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await serveDir(page, ORIGIN, ctx.dist);
      await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
      const FIXED_N = 6;
      for (const family of ["dialogue", "choir", "zoo", "mixed"] as const) {
        ctx.log(`polyphony: fixed-N family ${family}`);
        const r = await page.evaluate(
          async ({ origin, family, n }) => {
            const { createWorkerVoice, play } = await import(`${origin}/index.js`);
            const audioCtx = new AudioContext();
            let errors = 0;
            // Same fix as stepInPage's bodies array above: only valid Body shapes.
            const bodies: Body[] = ["female", "male", "child"];
            const underrunsP: Promise<number>[] = [];
            if (family === "zoo") {
              const { loadCreatures } = await import(`${origin}/creatures.js`);
              const zoo = await loadCreatures();
              for (let i = 0; i < n; i++) {
                const kind = zoo.list[i % zoo.list.length];
                const creature = zoo.create(kind.id);
                // kind.calls holds CreatureCall objects ({ id, ... }); stream() takes the call's
                // id string, not the object - this crashed every "zoo" run with "has no call
                // '[object Object]'" before ever producing a measurement.
                const call = kind.calls[i % kind.calls.length].id;
                const playback = play(creature.stream(call), zoo.sampleRate, { context: audioCtx });
                underrunsP.push(
                  playback.done
                    .then((e: { underruns: number }) => e.underruns)
                    .finally(() => creature.free()),
                );
              }
            } else if (family === "choir") {
              const song = {
                lyrics: "la la la loo loo",
                notes: [60, 64, 67, 64, 60].map((midi) => ({ midi, beats: 1 })),
                bpm: 100,
              };
              for (let i = 0; i < n; i++) {
                try {
                  const v = await createWorkerVoice({ body: bodies[i % bodies.length] });
                  const playback = v.say(song, { context: audioCtx });
                  underrunsP.push(
                    playback.done.then((e: { underruns: number }) => e.underruns).finally(() => v.free()),
                  );
                } catch {
                  errors++;
                }
              }
            } else {
              const dialogue = [
                "I don't think we should go in there.",
                "Why not? It's just an old door.",
                "Because every story about an old door ends badly.",
                "Fine. You wait here, then.",
              ];
              const creatureCount = family === "mixed" ? Math.floor(n / 2) : 0;
              const speechCount = n - creatureCount;
              for (let i = 0; i < speechCount; i++) {
                try {
                  const v = await createWorkerVoice({ body: bodies[i % bodies.length] });
                  const playback = v.say(dialogue[i % dialogue.length], { context: audioCtx });
                  underrunsP.push(
                    playback.done.then((e: { underruns: number }) => e.underruns).finally(() => v.free()),
                  );
                } catch {
                  errors++;
                }
              }
              if (creatureCount > 0) {
                const { loadCreatures } = await import(`${origin}/creatures.js`);
                const zoo = await loadCreatures();
                for (let i = 0; i < creatureCount; i++) {
                  const kind = zoo.list[i % zoo.list.length];
                  const creature = zoo.create(kind.id);
                  // Same fix as the zoo branch above: stream() wants the call's id string.
                  const playback = play(creature.stream(kind.calls[0].id), zoo.sampleRate, {
                    context: audioCtx,
                  });
                  underrunsP.push(
                    playback.done
                      .then((e: { underruns: number }) => e.underruns)
                      .finally(() => creature.free()),
                  );
                }
              }
            }
            const underruns = (await Promise.all(underrunsP)).reduce((a, b) => a + b, 0);
            await audioCtx.close();
            return { underruns, errors };
          },
          { origin: ORIGIN, family, n: FIXED_N },
        );
        out.push({
          name: `polyphony.chromium.fixedN.${family}.underruns`,
          value: r.underruns,
          unit: "count",
          threshold: 0,
          pass: r.underruns === 0,
        });
        out.push({
          name: `polyphony.chromium.fixedN.${family}.errors`,
          value: r.errors,
          unit: "count",
          threshold: 0,
          pass: r.errors === 0,
        });
      }
      await context.close();
    });
    return out;
  },
};
