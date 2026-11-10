"use client";

import { useRef, useState } from "react";
import { createToolRunner, type ToolResult, type ToolTarget } from "@/lib/intone/tools.js";
import { studio } from "@/lib/studio";
import styles from "./Agent.module.css";

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
const CALLS = [
  {
    name: "say",
    title: "Speak calmly",
    description: 'Say "Of course. I will keep it short."',
    input: { text: "Of course. I will keep it short.", mood: "calm" },
  },
  {
    name: "set_voice",
    title: "Change the voice",
    description: "Use a child voice for the next calls.",
    input: { body: "child" },
  },
  {
    name: "sing",
    title: "Try a melody with a rest",
    description: 'Sing "here it comes" with a silent beat between the notes.',
    input: { lyrics: "here it comes", melody: "E4:1 G4:1 r:1 C5:2", bpm: 110 },
  },
  {
    name: "sing",
    title: "Correct the melody and sing",
    description: "Hold the previous note for that beat instead of inserting a rest.",
    input: { lyrics: "here it comes", melody: "E4:1 G4:2 C5:2", bpm: 110, vibrato: 30 },
  },
];

function outcome(result: ToolResult, name: string) {
  if (!result.ok) {
    return result.error.includes("is a rest")
      ? "Rests are not supported. Hold the previous note for that beat instead."
      : result.error;
  }
  if (result.interrupted) return "Playback stopped before the end.";
  if (result.lost?.length) return `Finished without support for: ${result.lost.join(", ")}.`;
  if (result.voice) return `Voice changed to ${result.voice.body ?? "the default"}.`;
  return name === "sing" ? "The corrected melody was sung." : "The sentence was spoken.";
}

export function Agent() {
  const [results, setResults] = useState<ToolResult[]>([]);
  const [running, setRunning] = useState(false);
  const runner = useRef(createToolRunner(target, { body: "female" }));
  const generation = useRef(0);
  const cancelled = useRef(false);

  const run = async () => {
    const id = ++generation.current;
    cancelled.current = false;
    studio.unlock();
    setResults([]);
    setRunning(true);
    await runner.current.run("set_voice", {});
    for (const { name, input } of CALLS) {
      if (cancelled.current || generation.current !== id) break;
      const result = await runner.current.run(name, input);
      if (generation.current !== id) return;
      setResults((old) => [...old, result]);
      if (result.ok && result.interrupted) break;
    }
    if (generation.current === id) setRunning(false);
  };

  const stop = () => {
    cancelled.current = true;
    runner.current.stop();
    setRunning(false);
  };

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
        <ol className={styles.steps}>
          {CALLS.map(({ name, title, description, input }, index) => {
            const result = results[index];
            const active = running && index === results.length;
            const state = result
              ? !result.ok
                ? "refused"
                : result.interrupted
                  ? "stopped"
                  : "done"
              : active
                ? "running"
                : "waiting";
            const status = {
              refused: "Needs correction",
              stopped: "Stopped",
              done: "Done",
              running:
                name === "set_voice"
                  ? "Changing voice..."
                  : name === "say"
                    ? "Speaking..."
                    : "Trying melody...",
              waiting: "Next",
            }[state];
            return (
              <li key={`${name}-${title}`} data-state={state} aria-current={active ? "step" : undefined}>
                <span className={styles.number} aria-hidden="true">
                  {index + 1}
                </span>
                <div className={styles.step}>
                  <div className={styles.heading}>
                    <h3>{title}</h3>
                    <span className={styles.status} role="status">
                      {status}
                    </span>
                  </div>
                  <p>{description}</p>
                  {result ? <p className={styles.outcome}>{outcome(result, name)}</p> : null}
                  <details>
                    <summary>View tool call{result ? " and result" : ""}</summary>
                    <pre className="code wrapped">
                      {JSON.stringify(
                        { tool: name, arguments: input, ...(result ? { result } : {}) },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
