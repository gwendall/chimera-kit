"use client";

import { useRef, useState } from "react";
import { studio } from "@/lib/studio";
import { useStudio } from "./useStudio";

const FIRST_LINE = "I do not have a body, but I do have a throat.";

export function Hero() {
  const { ready, speaking, firstSampleMs } = useStudio();
  const [text, setText] = useState(FIRST_LINE);
  const [asTyped, setAsTyped] = useState(false);
  const lastWord = useRef("");

  const speak = () => {
    const line = text.trim();
    if (line) void studio.speak(line);
  };

  const typed = (value: string) => {
    setText(value);
    if (!asTyped || !/[\s.,!?]$/.test(value)) return;
    const word = value.trim().split(/\s+/).pop() ?? "";
    if (word && word !== lastWord.current) void studio.speak(word);
    lastWord.current = word;
  };

  return (
    <section>
      <span className="kicker">Speech synthesis, without a model</span>
      <h1>
        A voice
        <br />
        with a <em>throat.</em>
      </h1>
      <textarea
        className="say"
        value={text}
        rows={2}
        spellCheck={false}
        aria-label="Text to speak"
        placeholder="Say something."
        onChange={(event) => typed(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            speak();
          }
        }}
      />
      <div className="row">
        <button type="button" className="go" onClick={speaking ? () => studio.stop() : speak}>
          {speaking ? "Stop" : ready ? "Speak" : "Warming up"}
        </button>
        <label className="toggle">
          <input type="checkbox" checked={asTyped} onChange={(event) => setAsTyped(event.target.checked)} />
          speak each word as I type it
        </label>
      </div>
      <p>
        The shape on the right is not an animation. It is the simulation itself: every cell is a slice of a
        vocal tract, glowing where the air is moving hardest right now. Nothing you hear on this page is a
        recording.
      </p>
      <div className="stats">
        <div className="stat">
          <b>{firstSampleMs === null ? "..." : `${firstSampleMs.toFixed(1)} ms`}</b>
          <span>to the first sample, measured just now</span>
        </div>
        <div className="stat">
          <b>221 KB</b>
          <span>of engine, gzipped</span>
        </div>
        <div className="stat">
          <b>0</b>
          <span>model weights</span>
        </div>
        <div className="stat">
          <b>0</b>
          <span>words sent to a server</span>
        </div>
      </div>
    </section>
  );
}
