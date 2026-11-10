"use client";

import { useRef, useState } from "react";
import { type BodySpec, bodyFromSeed, MOODS, type Mood } from "@/lib/intone/index.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";

const LINE = "You can be anyone you like, and it only takes a few numbers.";
const CORNERS = { male: [50, 12], female: [8, 92], child: [92, 92] } as const;
const MOOD_NAMES = Object.keys(MOODS) as Mood[];

/** Dials on `BodySpec`, past the female/child blend the triangle already sets. */
interface DialSpec {
  key: keyof BodySpec;
  label: string;
  min: number;
  max: number;
  step: number;
}

const MAIN_DIALS: DialSpec[] = [
  { key: "size", label: "size", min: 0.7, max: 1.3, step: 0.01 },
  { key: "pitch", label: "pitch", min: -24, max: 24, step: 0.5 },
  { key: "breathiness", label: "breathiness", min: 0, max: 1, step: 0.01 },
  { key: "tension", label: "tension", min: 0, max: 1, step: 0.01 },
];

const MORE_DIALS: DialSpec[] = [
  { key: "throat", label: "throat", min: 0.7, max: 1.3, step: 0.01 },
  { key: "tongue", label: "tongue", min: 0.7, max: 1.3, step: 0.01 },
  { key: "lips", label: "lips", min: 0.7, max: 1.3, step: 0.01 },
  { key: "brightness", label: "brightness", min: 0, max: 1, step: 0.01 },
  { key: "fry", label: "fry", min: 0, max: 1, step: 0.01 },
  { key: "roughness", label: "roughness", min: 0, max: 1, step: 0.01 },
];

// A neutral starting point for the dials, before anyone has drawn a body. Not a claim about what
// an unset field defaults to inside the engine, just a reasonable place for the sliders to sit.
const DEFAULT_DIALS: BodySpec = {
  size: 1,
  throat: 1,
  tongue: 1,
  lips: 1,
  pitch: 0,
  breathiness: 0.15,
  tension: 0.5,
  brightness: 0.3,
  fry: 0,
  roughness: 0.1,
};

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

/** The triangle point a drawn body sits closest to, so the dot follows `bodyFromSeed`'s draw. */
function pointFromBody(body: BodySpec): [number, number] {
  const female = Math.max(0, Math.min(1, body.female ?? 0));
  const child = Math.max(0, Math.min(1, body.child ?? 0));
  const male = Math.max(0, 1 - female - child);
  const total = male + female + child || 1;
  const [ax, ay] = CORNERS.male;
  const [bx, by] = CORNERS.female;
  const [cx, cy] = CORNERS.child;
  return [(male * ax + female * bx + child * cx) / total, (male * ay + female * by + child * cy) / total];
}

const round = (value: number) => Number(value.toFixed(2));

function roundBody(body: BodySpec): BodySpec {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(body)) if (typeof value === "number") out[key] = round(value);
  return out as BodySpec;
}

function Dial({
  dial,
  value,
  onChange,
  onCommit,
}: {
  dial: DialSpec;
  value: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="dial">
      {dial.label}
      <input
        type="range"
        min={dial.min}
        max={dial.max}
        step={dial.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </label>
  );
}

export function Anyone() {
  const [point, setPoint] = useState<[number, number]>([50, 66]);
  const [body, setBody] = useState<BodySpec>(DEFAULT_DIALS);
  const [mood, setMood] = useState<Mood>("neutral");
  const [strength, setStrength] = useState(0.8);
  const [name, setName] = useState("");
  const dragging = useRef(false);
  const { male, female, child } = share(point[0], point[1]);

  const say = (
    at: [number, number] = point,
    withBody: BodySpec = body,
    withMood: Mood = mood,
    intensity = strength,
  ) => {
    const shares = share(at[0], at[1]);
    void studio.speak(LINE, {
      body: { ...withBody, female: shares.female, child: shares.child },
      style: withMood,
      intensity,
      label: "this voice",
    });
  };

  /** Draws a body from a seed, moves the triangle to match it, and speaks it. */
  const draw = (seed: number | string) => {
    const next = bodyFromSeed(seed);
    const at = pointFromBody(next);
    setBody(next);
    setPoint(at);
    say(at, next);
  };

  const askName = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed) draw(trimmed);
  };

  const json = JSON.stringify({
    body: { ...roundBody(body), female: round(female), child: round(child) },
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
        bodies, draw a new one, or type a name: it is a kind of voice, not a person's, and the line below is
        all of it.
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
        <button type="button" className="go" onClick={() => draw(Math.floor(Math.random() * 1e9))}>
          New voice
        </button>
        <form className="row" onSubmit={askName}>
          <input
            type="text"
            className="name-field"
            placeholder="a name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            aria-label="A name to hear as a voice"
          />
          <button type="submit" className="chip">
            that voice
          </button>
        </form>
        <Latency />
      </div>
      <div className="row">
        {MOOD_NAMES.map((moodName) => (
          <button
            key={moodName}
            type="button"
            className="chip"
            aria-pressed={mood === moodName}
            onClick={() => {
              setMood(moodName);
              say(point, body, moodName);
            }}
          >
            {moodName}
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
      <div className="dials">
        {MAIN_DIALS.map((dial) => (
          <Dial
            key={dial.key}
            dial={dial}
            value={body[dial.key] ?? 0}
            onChange={(value) => setBody((current) => ({ ...current, [dial.key]: value }))}
            onCommit={() => say()}
          />
        ))}
      </div>
      <details className="dials-more">
        <summary>More of the body</summary>
        <div className="dials">
          {MORE_DIALS.map((dial) => (
            <Dial
              key={dial.key}
              dial={dial}
              value={body[dial.key] ?? 0}
              onChange={(value) => setBody((current) => ({ ...current, [dial.key]: value }))}
              onCommit={() => say()}
            />
          ))}
        </div>
      </details>
      <div className="code">
        {json}
        <span className="hot">{`\n${bytes} bytes. That is the whole voice.`}</span>
      </div>
    </section>
  );
}
