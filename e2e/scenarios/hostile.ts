/**
 * Hostile inputs and hostile environments. Every case must settle (no hang) and, when it fails,
 * fail with a clear Error the caller can catch - never a silent stall and never an unhandled
 * page crash. This is also the regression test for the `playback.queued` hang fixed in
 * `src/player.ts` (see "no AudioWorklet support" and "strict CSP, no blob:" below).
 */
import { withBrowser } from "../lib/browsers.ts";
import { serveDir } from "../lib/serve.ts";
import type { Measurement, Scenario, ScenarioContext } from "../lib/types.ts";

const ORIGIN = "https://intone.e2e";
const GUARD_MS = 5000;

const HOSTILE_TEXTS: Record<string, string> = {
  empty: "",
  emoji: "Hello 😀🎤🔥🐍 there",
  huge100k: "The birch canoe slid on the smooth planks. ".repeat(2300), // ~101,200 chars
  rtlArabic: "مرحبا بك في هذا العالم الجميل، كيف حالك اليوم؟",
  numbers: "12345 3.14159 -42 1e10 0x1F",
  controlChars: "hello\x00\x01\x07\x1Bworld\x7F",
};

const HOSTILE_OPTIONS: Record<string, Record<string, number>> = {
  nanF0: { f0: Number.NaN },
  nanRate: { rate: Number.NaN },
  negativeRate: { rate: -5 },
  infiniteRate: { rate: Number.POSITIVE_INFINITY },
  hugeAccent: { accent: 1e9 },
  negativeAccent: { accent: -1e9 },
};

export const scenario: Scenario = {
  id: "hostile",
  description:
    "Hostile inputs (empty, emoji, 100k chars, RTL, control chars, NaN/out-of-range options) " +
    "and hostile environments (404s, wrong MIME, strict CSP, offline, no AudioWorklet).",
  smoke: false,
  async run(ctx: ScenarioContext): Promise<Measurement[]> {
    const out: Measurement[] = [];
    const name = "chromium" as const; // these probe JS/wasm behaviour, not a rendering engine difference
    await withBrowser(name, async (browser) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await serveDir(page, ORIGIN, ctx.dist);
      await page.goto(`${ORIGIN}/`, { waitUntil: "load" });

      for (const [label, text] of Object.entries(HOSTILE_TEXTS)) {
        ctx.log(`hostile: text ${label}`);
        const r = await page.evaluate(
          async ({ origin, text, guardMs }) => {
            const { createVoice } = await import(`${origin}/index.js`);
            const voice = await createVoice({ body: "female" });
            const race = Promise.race([
              (async () => {
                const { audio } = voice.render(text);
                let bad = 0;
                for (const s of audio) if (!Number.isFinite(s)) bad++;
                return { outcome: "resolved", length: audio.length, bad };
              })(),
              new Promise((resolve) => setTimeout(() => resolve({ outcome: "hang" }), guardMs)),
            ]).catch((e) => ({ outcome: "rejected", message: String(e?.message ?? e) }));
            const result = await race;
            voice.free();
            return result;
          },
          { origin: ORIGIN, text, guardMs: GUARD_MS },
        );
        const r2 = r as { outcome: string; length?: number; bad?: number; message?: string };
        out.push({
          name: `hostile.text.${label}`,
          value: r2.outcome === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: r2.outcome !== "hang",
          note:
            r2.outcome === "resolved"
              ? `${r2.length} samples, ${r2.bad} non-finite`
              : r2.outcome === "rejected"
                ? r2.message
                : undefined,
        });
        if (r2.outcome === "resolved" && (r2.bad ?? 0) > 0) {
          out.push({
            name: `hostile.text.${label}.nonFinite`,
            value: r2.bad ?? 0,
            unit: "samples",
            threshold: 0,
            pass: false,
          });
        }
      }

      for (const [label, options] of Object.entries(HOSTILE_OPTIONS)) {
        ctx.log(`hostile: options ${label}`);
        const r = await page.evaluate(
          async ({ origin, options, guardMs }) => {
            const { createVoice } = await import(`${origin}/index.js`);
            const race = Promise.race([
              (async () => {
                const voice = await createVoice({ body: "female", ...options });
                const { audio } = voice.render("Hello there.");
                voice.free();
                let bad = 0;
                for (const s of audio) if (!Number.isFinite(s)) bad++;
                return { outcome: "resolved", bad };
              })(),
              new Promise((resolve) => setTimeout(() => resolve({ outcome: "hang" }), guardMs)),
            ]).catch((e) => ({ outcome: "rejected", message: String(e?.message ?? e) }));
            return race;
          },
          { origin: ORIGIN, options, guardMs: GUARD_MS },
        );
        const r2 = r as { outcome: string; bad?: number; message?: string };
        out.push({
          name: `hostile.options.${label}`,
          value: r2.outcome === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: r2.outcome !== "hang" && (r2.outcome !== "resolved" || (r2.bad ?? 0) === 0),
          note:
            r2.outcome === "resolved"
              ? `${r2.bad} non-finite samples`
              : r2.outcome === "rejected"
                ? r2.message
                : undefined,
        });
      }
      await context.close();
    });

    // --- Hostile environments: each gets its own fresh page, since the failure is page-wide. ---
    await withBrowser(name, async (browser) => {
      const cases: Array<{
        label: string;
        serveOptions?: Parameters<typeof serveDir>[3];
        probe: "createVoice" | "noWorklet" | "offline";
      }> = [
        { label: "dictionary404", serveOptions: { missing: ["cmudict.txt.gz"] }, probe: "createVoice" },
        { label: "wasm404", serveOptions: { missing: ["intone_chimera.wasm"] }, probe: "createVoice" },
        {
          label: "wasmWrongMime",
          serveOptions: { wrongMime: { "intone_chimera.wasm": "text/plain" } },
          probe: "createVoice",
        },
        {
          label: "strictCspNoWasmUnsafeEval",
          serveOptions: { headers: { "Content-Security-Policy": "default-src 'self'; script-src 'self'" } },
          probe: "createVoice",
        },
      ];
      for (const c of cases) {
        ctx.log(`hostile: env ${c.label}`);
        const context = await browser.newContext();
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(e.message));
        await serveDir(page, ORIGIN, ctx.dist, c.serveOptions);
        await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
        const r = await page.evaluate(
          async ({ origin, guardMs }) => {
            const race = Promise.race([
              (async () => {
                const { createVoice } = await import(`${origin}/index.js`);
                const voice = await createVoice({ body: "female" });
                voice.free();
                return { outcome: "resolved" };
              })(),
              new Promise((resolve) => setTimeout(() => resolve({ outcome: "hang" }), guardMs)),
            ]).catch((e) => ({ outcome: "rejected", message: String(e?.message ?? e) }));
            return race;
          },
          { origin: ORIGIN, guardMs: GUARD_MS },
        );
        const r2 = r as { outcome: string; message?: string };
        // A hostile environment is expected to make loading fail; what matters is that it fails
        // *clearly* (a rejection with a message) rather than hanging or crashing the page unhandled.
        out.push({
          name: `hostile.env.${c.label}`,
          value: r2.outcome === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: r2.outcome !== "hang",
          note: r2.outcome === "rejected" ? r2.message : r2.outcome,
        });
        if (pageErrors.length > 0) {
          out.push({
            name: `hostile.env.${c.label}.unhandledPageErrors`,
            value: pageErrors.length,
            unit: "count",
            threshold: 0,
            pass: false,
            note: pageErrors[0],
          });
        }
        await context.close();
      }

      // No AudioWorklet support (or a CSP that blocks the blob: URL addProcessor loads through):
      // the regression case for the queued-hang fix in src/player.ts.
      ctx.log("hostile: env noAudioWorklet");
      {
        const context = await browser.newContext();
        const page = await context.newPage();
        await serveDir(page, ORIGIN, ctx.dist);
        await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
        const r = await page.evaluate(
          async ({ origin, guardMs }) => {
            const proto = Object.getPrototypeOf(new AudioContext().audioWorklet);
            proto.addModule = () => Promise.reject(new Error("simulated: no AudioWorklet / blocked by CSP"));
            const { createVoice, play } = await import(`${origin}/index.js`);
            const voice = await createVoice({ body: "female" });
            const playback = play(voice.stream("Hello there."), voice.sampleRate);
            const queued = await Promise.race([
              playback.queued.then(() => "resolved").catch((e: unknown) => `rejected: ${e}`),
              new Promise((resolve) => setTimeout(() => resolve("hang"), guardMs)),
            ]);
            const done = await Promise.race([
              playback.done.then(() => "resolved").catch((e: unknown) => `rejected: ${e}`),
              new Promise((resolve) => setTimeout(() => resolve("hang"), guardMs)),
            ]);
            voice.free();
            return { queued, done };
          },
          { origin: ORIGIN, guardMs: GUARD_MS },
        );
        const r2 = r as { queued: string; done: string };
        out.push({
          name: "hostile.env.noAudioWorklet.queued",
          value: r2.queued === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: r2.queued !== "hang",
          note: r2.queued,
        });
        out.push({
          name: "hostile.env.noAudioWorklet.done",
          value: r2.done === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: r2.done !== "hang" && r2.done.startsWith("rejected"),
          note: r2.done,
        });
        await context.close();
      }

      // Offline after load: a voice already created must keep rendering with no network; a new
      // one must fail clearly, not hang, when there is nothing to fetch from.
      ctx.log("hostile: env offlineAfterLoad");
      {
        const context = await browser.newContext();
        const page = await context.newPage();
        await serveDir(page, ORIGIN, ctx.dist);
        await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
        await page.evaluate(async (origin) => {
          const { createVoice } = await import(`${origin}/index.js`);
          (globalThis as unknown as { __v: unknown }).__v = await createVoice({ body: "female" });
        }, ORIGIN);
        await context.setOffline(true);
        const r = await page.evaluate(
          async ({ origin, guardMs }) => {
            const existing = (
              globalThis as unknown as { __v: { render(t: string): { audio: Float32Array } } }
            ).__v;
            const stillWorks = existing.render("Hello there.").audio.length > 0;
            const race = Promise.race([
              (async () => {
                const { createVoice } = await import(`${origin}/index.js`);
                await createVoice({ body: "female", wasm: `${origin}/intone_chimera.wasm?fresh=1` });
                return "resolved";
              })(),
              new Promise((resolve) => setTimeout(() => resolve("hang"), guardMs)),
            ]).catch((e) => `rejected: ${e}`);
            const newVoice = await race;
            return { stillWorks, newVoice };
          },
          { origin: ORIGIN, guardMs: GUARD_MS },
        );
        const r2 = r as { stillWorks: boolean; newVoice: string };
        out.push({
          name: "hostile.env.offline.existingVoiceStillRenders",
          value: r2.stillWorks ? 1 : 0,
          unit: "bool",
          threshold: 1,
          pass: r2.stillWorks,
        });
        out.push({
          name: "hostile.env.offline.newVoiceFailsClearly",
          value: r2.newVoice === "hang" ? 1 : 0,
          unit: "hang(1)/settled(0)",
          threshold: 0,
          pass: r2.newVoice !== "hang",
          note: r2.newVoice,
        });
        await context.close();
      }
    });
    return out;
  },
};
