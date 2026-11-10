"use client";

import { useRef, useState } from "react";
import { play } from "@/lib/intone/index.js";
import type { EngineName, Speaker } from "@/lib/intone/speaker.js";
import { studio } from "@/lib/studio";

const LINE = "The same call, a different voice.";
const ASK = { f0: 190, delivery: "excited" } as const;

const ENGINES: { id: EngineName; name: string; weight: string; action: string }[] = [
  { id: "chimera", name: "CHIMERA", weight: "274 KB, already here", action: "Play" },
  { id: "web-speech", name: "Your device's voice", weight: "Nothing to download", action: "Play" },
  {
    id: "kokoro",
    name: "Kokoro, a neural voice",
    weight: "88 MB on first use",
    action: "Download 88 MB and play",
  },
];

interface Result {
  state: "loading" | "speaking" | "done" | "failed";
  readyMs?: number;
  firstMs?: number | null;
  lost?: string[];
  error?: string;
}

const ms = (value: number | null | undefined) =>
  value === undefined
    ? "..."
    : value === null
      ? "not reported"
      : value < 2000
        ? `${value.toFixed(0)} ms`
        : `${(value / 1000).toFixed(1)} s`;

export function Engines() {
  const [results, setResults] = useState<Partial<Record<EngineName, Result>>>({});
  const [last, setLast] = useState<EngineName>("chimera");
  const speakers = useRef(new Map<EngineName, Speaker>());
  const speakerStop = useRef<(() => void) | null>(null);

  const update = (id: EngineName, patch: Result | Partial<Result>) =>
    setResults((old) => ({ ...old, [id]: { ...old[id], ...patch } as Result }));

  const run = async (id: EngineName) => {
    setLast(id);
    studio.stop();
    speakerStop.current?.();
    const { context, output } = studio.route();
    update(id, { state: "loading" });
    try {
      let speaker = speakers.current.get(id);
      if (!speaker) {
        const asked = performance.now();
        const { createSpeaker } = await import("@/lib/intone/speaker.js");
        speaker = await createSpeaker(id);
        speakers.current.set(id, speaker);
        update(id, { readyMs: performance.now() - asked });
      }
      update(id, { state: "speaking", firstMs: undefined, lost: undefined });
      const calledAt = performance.now();

      if (speaker.output === "samples" && speaker.stream && speaker.sampleRate) {
        const chunks = speaker.stream(LINE, ASK);
        let first = true;
        const stamped = async function* () {
          for (;;) {
            const next = await chunks.next();
            if (next.done) {
              update(id, { lost: next.value });
              return;
            }
            if (first) {
              first = false;
              const taken = performance.now() - calledAt;
              update(id, { firstMs: taken });
              studio.note(taken);
            }
            yield next.value;
          }
        };
        const playback = play(stamped(), speaker.sampleRate, { context, destination: output });
        speakerStop.current = playback.stop;
        await playback.done;
      } else {
        const said = speaker.say(LINE, ASK);
        speakerStop.current = said.stop;
        update(id, { lost: said.lost, firstMs: null });
        await said.done;
      }
      update(id, { state: "done" });
    } catch (error) {
      update(id, { state: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <section id="engines">
      <div className="intro">
        <span className="label">Engines</span>
        <h2>{"Need a natural voice? Change one line."}</h2>
        <p>
          {
            "The same calls also drive the browser's built-in voices and Kokoro, a neural model that runs on your device. Each engine says plainly what it cannot do, such as singing."
          }
        </p>
      </div>
      <div className="code">
        <span className="hot">{`const speaker = await createSpeaker("${last}");`}</span>
        {`\nconst { lost } = speaker.say("${LINE}", {\n  f0: ${ASK.f0}, delivery: "${ASK.delivery}",\n});`}
      </div>
      <div className="engines">
        {ENGINES.map(({ id, name, weight, action }) => {
          const result = results[id];
          const busy = result?.state === "loading" || result?.state === "speaking";
          return (
            <div className="engine" key={id}>
              <div>
                <h3>{name}</h3>
                <span className="latency">{weight}</span>
              </div>
              <button type="button" className="chip" disabled={busy} onClick={() => void run(id)}>
                {result?.state === "loading"
                  ? "Loading"
                  : result?.state === "speaking"
                    ? "Speaking"
                    : result?.readyMs
                      ? "Play"
                      : action}
              </button>
              <dl>
                <dt>ready in</dt>
                <dd>{ms(result?.readyMs)}</dd>
                <dt>first sound</dt>
                <dd>{ms(result?.firstMs)}</dd>
                <dt>could not do</dt>
                <dd>
                  {result?.state === "failed"
                    ? `failed: ${result.error}`
                    : result?.lost
                      ? result.lost.join(", ") || "nothing"
                      : "..."}
                </dd>
              </dl>
            </div>
          );
        })}
      </div>
    </section>
  );
}
