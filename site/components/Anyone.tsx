"use client";

import { useRef, useState } from "react";
import { MOODS, type Mood } from "@/lib/intone/index.js";
import { studio } from "@/lib/studio";

const LINE = "You can be anyone you like, as long as you have a throat.";
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

export function Anyone() {
  const [point, setPoint] = useState<[number, number]>([50, 66]);
  const [mood, setMood] = useState<Mood>("neutral");
  const [strength, setStrength] = useState(0.8);
  const dragging = useRef(false);
  const { male, female, child } = share(point[0], point[1]);

  const say = (at = point, withMood = mood) => {
    const shares = share(at[0], at[1]);
    void studio.speak(LINE, {
      body: { female: shares.female, child: shares.child },
      style: withMood,
      intensity: strength,
    });
  };

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
      <span className="kicker">Bodies and moods</span>
      <h2>
        Change the <em>body,</em>
        <br />
        not the file.
      </h2>
      <p>
        A voice here is a set of measurements, so a new one costs nothing. Drag between the three bodies and
        watch the tube change length.
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
    </section>
  );
}
