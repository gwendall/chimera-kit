"use client";

import { useRef, useState } from "react";
import { MOODS, type Mood } from "@/lib/intone/index.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";

const LINE = "You can be anyone you like, and it only takes a few numbers.";
const CORNERS = { male: [50, 12], female: [8, 92], child: [92, 92] } as const;
const MOOD_NAMES = Object.keys(MOODS) as Mood[];

function share(x: number, y: number) {
  const [ax, ay] = CORNERS.male;
  const [bx, by] = CORNERS.female;
  const [cx, cy] = CORNERS.child;
  const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  const male = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
  const female = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
  const child = 1 - male - female;
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const total = clamp(male) + clamp(female) + clamp(child) || 1;
  return { male: clamp(male) / total, female: clamp(female) / total, child: clamp(child) / total };
}

interface Traits {
  f0?: number;
  rate?: number;
  accent?: number;
}

const round = (value: number) => Number(value.toFixed(2));

export function Anyone() {
  const [point, setPoint] = useState<[number, number]>([50, 66]);
  const [mood, setMood] = useState<Mood>("neutral");
  const [strength, setStrength] = useState(0.8);
  const [traits, setTraits] = useState<Traits>({});
  const dragging = useRef(false);
  const { male, female, child } = share(point[0], point[1]);

  const say = (at = point, withMood = mood, withTraits = traits, intensity = strength) => {
    const shares = share(at[0], at[1]);
    void studio.speak(LINE, {
      body: { female: shares.female, child: shares.child },
      style: withMood,
      intensity,
      label: "this voice",
      ...withTraits,
    });
  };

  const surprise = () => {
    const a = Math.random();
    const b = Math.random() * (1 - a);
    const c = 1 - a - b;
    const at: [number, number] = [
      a * CORNERS.male[0] + b * CORNERS.female[0] + c * CORNERS.child[0],
      a * CORNERS.male[1] + b * CORNERS.female[1] + c * CORNERS.child[1],
    ];
    const pitchTop = 120 + (b + c) * 150;
    const next: Traits = {
      f0: Math.round(pitchTop * (0.8 + Math.random() * 0.4)),
      rate: round(0.85 + Math.random() * 0.5),
      accent: round(0.1 + Math.random() * 0.8),
    };
    const nextMood = MOOD_NAMES[Math.floor(Math.random() * MOOD_NAMES.length)] ?? "neutral";
    const nextStrength = round(0.4 + Math.random() * 0.6);
    setPoint(at);
    setMood(nextMood);
    setStrength(nextStrength);
    setTraits(next);
    say(at, nextMood, next, nextStrength);
  };

  const json = JSON.stringify({
    body: { female: round(female), child: round(child) },
    ...traits,
    delivery: mood,
    intensity: strength,
  });
  const bytes = new TextEncoder().encode(json).length;

  const move = (event: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const box = event.currentTarget.getBoundingClientRect();
    const next: [number, number] = [
      Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)),
      Math.max(0, Math.min(100, ((event.clientY - box.top) / box.height) * 100)),
    ];
    setPoint(next);
    return next;
  };

  return (
    <section>
      <span className="kicker">Voices</span>
      <h2>
        A voice is
        <br />a <em>few numbers.</em>
      </h2>
      <p>
        Not a model and not a recording, so a thousand characters can each have their own. Drag between the
        bodies, pick a mood, or roll a new voice: the line below is all of it.
      </p>
      <svg
        className="pad"
        viewBox="0 0 100 100"
        role="img"
        aria-label={`Body blend: ${Math.round(male * 100)} percent man, ${Math.round(female * 100)} percent woman, ${Math.round(child * 100)} percent child`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = true;
          move(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) move(event);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          say(move(event));
        }}
      >
        <polygon points="50,12 8,92 92,92" fill="#15120f" stroke="#3a332c" strokeWidth="0.4" />
        <text x="50" y="7" textAnchor="middle" fontSize="4" fill="#c9c1b5">
          man
        </text>
        <text x="4" y="98" fontSize="4" fill="#c9c1b5">
          woman
        </text>
        <text x="96" y="98" textAnchor="end" fontSize="4" fill="#c9c1b5">
          child
        </text>
        <circle cx={point[0]} cy={point[1]} r="3" fill="#ff5c36" />
      </svg>
      <div className="row">
        {MOOD_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            className="chip"
            aria-pressed={mood === name}
            onClick={() => {
              setMood(name);
              say(point, name);
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <label className="slider">
        intensity
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={strength}
          onChange={(event) => setStrength(Number(event.target.value))}
        />
      </label>
      <div className="row">
        <button type="button" className="go" onClick={surprise}>
          Surprise me
        </button>
        <Latency />
      </div>
      <div className="code">
        {json}
        <span className="hot">{`\n${bytes} bytes. That is the whole voice.`}</span>
      </div>
    </section>
  );
}
