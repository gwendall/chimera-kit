"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Score } from "@/lib/intone/index.js";
import { take } from "@/lib/intone/index.js";
import { studio } from "@/lib/studio";
import { useStudio } from "./useStudio";

const SENTENCE = "I never said she stole my money.";
const MEANINGS: Record<string, string> = {
  I: "Someone else said it.",
  never: "Not once. Not ever.",
  said: "I may have implied it.",
  she: "Somebody else stole it.",
  stole: "She did something else with it.",
  my: "It was somebody else's money.",
  money: "She took something else of mine.",
};
const WORDS = SENTENCE.replace(".", "").split(" ");
const SPREAD = 0.14;

interface Bend {
  t: number;
  semitones: number;
}

/** The planned pitch resampled finely, with the listener's bends laid over it. */
function bent(score: Score, bends: Bend[]): Score {
  const pitch: [number, number][] = [];
  const value = (t: number) => {
    const c = score.pitch;
    let a = c[0];
    for (const point of c) {
      if (point[0] > t) {
        if (!a) return point[1];
        return a[1] + ((point[1] - a[1]) * (t - a[0])) / Math.max(point[0] - a[0], 1e-6);
      }
      a = point;
    }
    return a?.[1] ?? 120;
  };
  for (let t = 0; t <= score.duration; t += 0.01) {
    let semitones = 0;
    for (const bend of bends)
      semitones += bend.semitones * Math.exp(-((t - bend.t) ** 2) / (2 * SPREAD ** 2));
    pitch.push([t, value(t) * 2 ** (semitones / 12)]);
  }
  return { ...score, pitch };
}

function leanOn(plain: Score, word: string): Score {
  const shaped = take(plain);
  shaped.word(word).emphasize();
  return shaped.score;
}

export function Direct() {
  const { ready } = useStudio();
  const [word, setWord] = useState<string | null>(null);
  const [base, setBase] = useState<Score | null>(null);
  const [bends, setBends] = useState<Bend[]>([]);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ t: number; y: number; start: Bend[] } | null>(null);

  useEffect(() => {
    if (!ready) return;
    void studio.plan(SENTENCE).then((plain) => {
      setBase(word ? leanOn(plain, word) : plain);
    });
  }, [ready, word]);

  const score = useMemo(() => (base ? bent(base, bends) : null), [base, bends]);

  const choose = async (next: string) => {
    setWord(next);
    setBends([]);
    const plain = await studio.plan(SENTENCE);
    const shaped = leanOn(plain, next);
    setBase(shaped);
    void studio.speak(shaped);
  };

  const place = (event: React.PointerEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !score) return null;
    return { t: ((event.clientX - box.left) / box.width) * score.duration, y: event.clientY - box.top };
  };

  const path = useMemo(() => {
    if (!score || !base) return "";
    // Centered on this sentence's own pitch, about an octave and a half of room around it.
    const sorted = base.pitch.map(([, hz]) => hz).sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length / 2)] ?? 200;
    const LOW = Math.log(middle / 2 ** (11 / 12));
    const HIGH = Math.log(middle * 2 ** (11 / 12));
    return score.pitch
      .map(([t, hz], i) => {
        const x = (t / score.duration) * 1000;
        const y = (1 - (Math.log(hz) - LOW) / (HIGH - LOW)) * 170;
        return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join("");
  }, [score, base]);

  return (
    <section>
      <span className="kicker">Direction</span>
      <h2>
        One sentence.
        <br />
        <em>Seven</em> meanings.
      </h2>
      <p>Other voices guess what you mean. This one does what it is told: click a word to lean on it.</p>
      <div className="sentence">
        {WORDS.map((w) => (
          <button key={w} type="button" aria-pressed={word === w} onClick={() => void choose(w)}>
            {w}
          </button>
        ))}
      </div>
      <div className="meaning">{word ? MEANINGS[word] : " "}</div>
      <svg
        ref={svg}
        className="editor"
        viewBox="0 0 1000 170"
        preserveAspectRatio="none"
        role="img"
        aria-label="Pitch of the sentence. Drag up or down to bend it."
        onPointerDown={(event) => {
          const at = place(event);
          if (!at) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { ...at, start: bends };
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          const at = place(event);
          if (!from || !at) return;
          setBends([...from.start, { t: from.t, semitones: (from.y - at.y) / 8 }]);
        }}
        onPointerUp={() => {
          drag.current = null;
          if (score) void studio.speak(score);
        }}
      >
        {score?.words?.map((w) => (
          <g key={`${w.text}${w.t0}`}>
            <line
              x1={(w.t0 / score.duration) * 1000}
              x2={(w.t0 / score.duration) * 1000}
              y1="0"
              y2="170"
              stroke="#2b2622"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
        <path d={path} fill="none" stroke="#ff5c36" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="row">
        <span className="kicker">Pull the line up or down. It is the pitch the voice will sing.</span>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            setBends([]);
          }}
        >
          Reset
        </button>
      </div>
      <div className="code">
        {'const t = take(voice.plan("I never said she stole my money."));\n'}
        <span className="hot">{`t.word("${word ?? "never"}").emphasize();`}</span>
        {"\nvoice.render(t.score);"}
      </div>
    </section>
  );
}
