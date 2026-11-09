"use client";

import { useRef, useState } from "react";
import { studio } from "@/lib/studio";

const ANSWER =
  "You asked how fast this can start. Faster than you can tell. The first clause leaves at its first comma, while the model is still writing the rest of the sentence, and each clause is computed while the one before it plays. If you interrupt me, I stop at once.";
const TOKENS_PER_SECOND = 40;

export function Live() {
  const [shown, setShown] = useState("");
  const [running, setRunning] = useState(false);
  const [firstMs, setFirstMs] = useState<number | null>(null);
  const cancelled = useRef(false);

  const start = () => {
    cancelled.current = false;
    setShown("");
    setFirstMs(null);
    setRunning(true);
    const startedAt = performance.now();
    async function* tokens() {
      for (const token of ANSWER.match(/\S+\s*/g) ?? []) {
        if (cancelled.current) return;
        await new Promise((resolve) => setTimeout(resolve, 1000 / TOKENS_PER_SECOND));
        setShown((old) => old + token);
        yield token;
      }
    }
    void studio
      .speakTokens(tokens(), { onFirstSample: () => setFirstMs(performance.now() - startedAt) })
      .finally(() => setRunning(false));
  };

  const stop = () => {
    cancelled.current = true;
    studio.stop();
    setRunning(false);
  };

  return (
    <section>
      <span className="kicker">For conversations</span>
      <h2>
        It speaks while
        <br />
        the answer is <em>being written.</em>
      </h2>
      <p>
        Below, tokens arrive at the pace of a language model. Sound starts after the first few, not after the
        last, and Interrupt really stops it: nothing was queued on a server.
      </p>
      <div className="tokens">
        {shown}
        {running ? <i>▍</i> : null}
      </div>
      <div className="row">
        <button type="button" className="go" onClick={running ? stop : start}>
          {running ? "Interrupt" : "Stream an answer"}
        </button>
        <span className="kicker">
          {firstMs === null ? " " : `first sound ${Math.round(firstMs)} ms after the first token`}
        </span>
      </div>
    </section>
  );
}
