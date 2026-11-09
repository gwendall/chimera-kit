"use client";

import { useEffect, useRef, useState } from "react";
import type { Score } from "@/lib/intone/index.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";
import { useStudio } from "./useStudio";

const LINE = "Hello there.";

export function Layers() {
  const { ready } = useStudio();
  const [score, setScore] = useState<Score | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const seen = new IntersectionObserver(
      (entries) => {
        studio.showThroat = entries.some((entry) => entry.isIntersecting);
      },
      { threshold: 0.25 },
    );
    seen.observe(node);
    return () => seen.disconnect();
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
    <section ref={section}>
      <span className="kicker">How it works</span>
      <h2>
        Plain data,
        <br />
        all the way <em>down.</em>
      </h2>
      <p>
        Each step is a value you can read, change and hand back. Stay at the top and it is one line of code;
        drop as low as you want and you are moving a tongue.
      </p>
      <p>
        The monitor has switched to what is underneath:{" "}
        <a href="https://github.com/jamesondh/chimera-vocal-synth">CHIMERA</a>, by{" "}
        <a href="https://github.com/jamesondh">Jameson Hodge</a>, simulates air moving through a vocal tract,
        one cell per slice. intone is what makes that usable in a product: streaming, clause cutting for
        language models, direction, workers, and an interface that also drives other engines.
      </p>
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
        Honest numbers: speech recognizers miss about 23 % of its words, far more than for a neural voice. It
        is not trying to pass for a person. What it gives you instead is a voice that starts at once, weighs
        almost nothing and does exactly what a program tells it. The optional pronouncing dictionary adds 869
        KB.
      </p>
    </section>
  );
}
