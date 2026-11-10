"use client";

import { useEffect, useRef, useState } from "react";
import type { Score } from "@/lib/intone/index.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";
import { Throat } from "./Throat";
import { useStudio } from "./useStudio";

const LINE = "Hello there.";

export function Layers() {
  const { ready } = useStudio();
  const [score, setScore] = useState<Score | null>(null);
  const [visible, setVisible] = useState(false);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const seen = new IntersectionObserver(
      (entries) => {
        const on = entries.some((entry) => entry.isIntersecting);
        studio.showThroat = on;
        setVisible(on);
      },
      { threshold: 0.1 },
    );
    seen.observe(node);
    return () => {
      seen.disconnect();
      studio.showThroat = false;
    };
  }, []);

  useEffect(() => {
    if (ready) void studio.plan(LINE).then(setScore);
  }, [ready]);

  const sounds = score?.sounds
    .filter((s) => s.sound !== "_")
    .slice(0, 6)
    .map((s) => `${s.sound} ${s.t0.toFixed(2)}`)
    .join(", ");

  return (
    <section id="how" ref={section}>
      <div className="intro">
        <span className="label">How it works</span>
        <h2>{"No neural network. A simulated throat."}</h2>
        <p>
          {
            "Most modern text to speech runs a neural network trained on recordings of people. intone runs CHIMERA, a physical model of the human voice by Jameson Hodge: vocal folds, a throat, a tongue and lips, simulated sample by sample. Every sound comes from those movements. That is why each word can be moved exactly, and why the whole engine fits in 273 KB. Each step below is plain data you can read, change and hand back."
          }
        </p>
      </div>
      <div className="throat-screen">{visible ? <Throat /> : null}</div>
      <div className="row">
        <button type="button" className="go" disabled={!ready} onClick={() => void studio.speak(LINE)}>
          Say it and watch the tract
        </button>
        <Latency />
      </div>
      <div className="layers">
        <div className="layer">
          <span>4</span>
          <b>Intention</b>
          <code>{`"${LINE}", { delivery: "calm" }`}</code>
        </div>
        <div className="layer">
          <span>3</span>
          <b>Phrasing</b>
          <code>words, syllables, stress, where to breathe</code>
        </div>
        <div className="layer">
          <span>2</span>
          <b>Score</b>
          <code>{sounds ? `${sounds} ...` : "planning..."}</code>
        </div>
        <div className="layer">
          <span>1</span>
          <b>Gestures</b>
          <code>tongue, lips, jaw and velum moving to their targets</code>
        </div>
        <div className="layer">
          <span>0</span>
          <b>Signal</b>
          <code>air through a tube, 48,000 times a second</code>
        </div>
      </div>
      <div className="code">
        {
          'import { createVoice, play } from "intone";\n\nconst voice = await createVoice({ body: "female" });\nawait play(voice.stream("Hello there."), voice.sampleRate).done;'
        }
      </div>
      <p>
        Speech recognizers miss about 23 % of its words, far more than for a neural voice: it is not trying to
        pass for a person. In exchange it starts at once, weighs almost nothing and does exactly what the
        program tells it.
      </p>
    </section>
  );
}
