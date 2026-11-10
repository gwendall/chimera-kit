"use client";

import { useRef, useState } from "react";
import { createToolRunner, type ToolResult, type ToolTarget } from "@/lib/intone/tools.js";
import { studio } from "@/lib/studio";

/** Plays through the page's own studio, so the monitor shows these calls like any other speech. */
const target: ToolTarget = {
  say(input, options = {}) {
    const { body, delivery, intensity, f0, rate } = options;
    const started = studio.speak(input, {
      ...(body === undefined ? {} : { body }),
      ...(delivery === undefined ? {} : { style: delivery }),
      ...(intensity === undefined ? {} : { intensity }),
      ...(f0 === undefined ? {} : { f0 }),
      ...(rate === undefined ? {} : { rate }),
      label: "tool call",
    });
    return {
      queued: started,
      done: started.then((playback) => playback.done),
      stop: () => studio.stop(),
    };
  },
};

/** What a model would send, one call at a time, the third of them a mistake it then repairs. */
const CALLS: { name: string; input: Record<string, unknown> }[] = [
  { name: "say", input: { text: "Of course. I will keep it short.", mood: "calm" } },
  { name: "set_voice", input: { body: "child" } },
  { name: "sing", input: { lyrics: "here it comes", melody: "E4:1 G4:1 r:1 C5:2", bpm: 110 } },
  { name: "sing", input: { lyrics: "here it comes", melody: "E4:1 G4:2 C5:2", bpm: 110, vibrato: 30 } },
];

const pretty = (name: string, input: unknown) => `${name} ${JSON.stringify(input)}`;

export function Agent() {
  const [results, setResults] = useState<ToolResult[]>([]);
  const [running, setRunning] = useState(false);
  const runner = useRef(createToolRunner(target, { body: "female" }));

  const run = async () => {
    setResults([]);
    setRunning(true);
    await runner.current.run("set_voice", {});
    for (const { name, input } of CALLS) {
      const result = await runner.current.run(name, input);
      setResults((old) => [...old, result]);
      if (result.ok && result.interrupted) break;
    }
    setRunning(false);
  };

  const stop = () => {
    runner.current.stop();
    setRunning(false);
  };

  const shown = CALLS.slice(0, Math.min(CALLS.length, results.length + (running ? 1 : 0)));

  return (
    <section id="agents">
      <div className="intro">
        <span className="label">For AI agents</span>
        <h2>{"A language model can use it as a tool."}</h2>
        <p>
          {
            "One import gives a model three tools, in the formats the Anthropic and OpenAI APIs expect: say, sing and set the voice. A bad call comes back as a message the model can read and fix, never as a crash. The calls below are scripted so this page needs no account, but they run through the same code."
          }
        </p>
      </div>
      <div className="panel">
        <div className="row">
          <button type="button" className="go" onClick={running ? stop : () => void run()}>
            {running ? "Interrupt" : "Run the tool calls"}
          </button>
        </div>
        <div className="code wrapped" aria-live="polite">
          {shown.length === 0 ? "// the calls appear here as they run\n" : null}
          {shown.map(({ name, input }, index) => {
            const result = results[index];
            return (
              <span key={`${name}-${JSON.stringify(input)}`}>
                {`${pretty(name, input)}\n`}
                {result === undefined ? null : result.ok ? (
                  `  ${JSON.stringify(result)}\n`
                ) : (
                  <span className="hot">{`  ${JSON.stringify(result)}\n`}</span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
