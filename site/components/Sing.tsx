"use client";

import { useRef, useState } from "react";
import { compose, type Song } from "@/lib/intone/index.js";
import { fall, harmony, type Part, scoop } from "@/lib/intone/singing.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";

// An original tune and words, written for this page.
const SYLLABLES = "No- bo- dy taught me how to sing, I on- ly have a tube of air.".split(" ");
const LYRICS = "No-bo-dy taught me how to sing, I on-ly have a tube of air.";
const START = [62, 64, 66, 69, 67, 66, 64, 62, 66, 67, 69, 74, 73, 69, 67, 69];
const BEATS = [1, 0.5, 0.5, 1, 0.5, 0.5, 1, 2, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, 2];
const TOP = 78;
const ROWS = 22;
/** The parts on offer, each with who sings it. */
const PARTS: { part: Part; label: string; body: "female" | "male" | "child" }[] = [
  { part: "third-above", label: "Third above", body: "child" },
  { part: "third-below", label: "Third below", body: "female" },
  { part: "octave-below", label: "Octave below", body: "male" },
];

export function Sing() {
  const [midi, setMidi] = useState(START);
  const [vibrato, setVibrato] = useState(30);
  const [chosen, setChosen] = useState<Part[]>([]);
  const [ornate, setOrnate] = useState(false);
  const drag = useRef<{ index: number; startY: number; startMidi: number } | null>(null);
  const total = BEATS.reduce((a, b) => a + b, 0);

  const sing = async (notes = midi) => {
    const song: Song = {
      lyrics: LYRICS,
      bpm: 92,
      vibrato,
      notes: notes.map((n, i) => ({ midi: n, beats: BEATS[i] ?? 1 })),
    };
    // A style is a function a worker can't receive, so the score is shaped here and sent as data.
    const style = compose(scoop(), fall());
    const shaped = async (input: Song, body: "female" | "male" | "child") =>
      ornate ? style(await studio.plan(input, body)) : input;
    const lines = [
      { input: song, body: "female" as const },
      ...PARTS.filter(({ part }) => chosen.includes(part)).map(({ part, body }) => ({
        input: harmony(song, part),
        body,
      })),
    ];
    if (lines.length === 1) {
      void studio.speak(await shaped(song, "female"), { body: "female", label: "singing" });
      return;
    }
    void studio.parts(
      await Promise.all(lines.map(async ({ input, body }) => ({ input: await shaped(input, body), body }))),
    );
  };
  const toggle = (part: Part) =>
    setChosen((old) => (old.includes(part) ? old.filter((p) => p !== part) : [...old, part]));

  let beat = 0;
  return (
    <section>
      <span className="kicker">Singing</span>
      <h2>
        It can carry
        <br />a <em>tune.</em>
      </h2>
      <p>
        The same engine, on notes. Drag any note up or down and it sings the new melody straight away. Add a
        part and another simulated throat joins in, on harmony worked out from your notes.
      </p>
      <svg
        className="roll"
        viewBox="0 0 1000 250"
        preserveAspectRatio="none"
        role="img"
        aria-label="Melody editor"
      >
        {BEATS.map((length, i) => {
          const note = midi[i] ?? 60;
          const x = (beat / total) * 1000;
          const width = (length / total) * 1000 - 4;
          beat += length;
          const y = ((TOP - note) / ROWS) * 250;
          return (
            <g
              // biome-ignore lint/suspicious/noArrayIndexKey: notes never reorder, dragging only changes their pitch
              key={`${i}-${length}`}
              style={{ cursor: "ns-resize", touchAction: "none" }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { index: i, startY: event.clientY, startMidi: note };
              }}
              onPointerMove={(event) => {
                const from = drag.current;
                if (!from || from.index !== i) return;
                const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                if (!box) return;
                const step = box.height / ROWS;
                const next = Math.max(
                  TOP - ROWS + 1,
                  Math.min(TOP, from.startMidi + Math.round((from.startY - event.clientY) / step)),
                );
                setMidi((old) => old.map((n, at) => (at === i ? next : n)));
              }}
              onPointerUp={() => {
                drag.current = null;
                void sing();
              }}
            >
              <rect x={x} y={y} width={width} height={250 / ROWS - 2} fill="#ff5c36" rx="2" />
              <text x={x + 4} y={y - 4} fontSize="12" fill="#c9c1b5" fontFamily="var(--font-mono)">
                {(SYLLABLES[i] ?? "").replace(/[-,.]/g, "")}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="row">
        <button type="button" className="go" onClick={() => void sing()}>
          Sing it
        </button>
        <button type="button" className="ghost-button" onClick={() => setMidi(START)}>
          Reset
        </button>
        <label className="slider">
          vibrato
          <input
            type="range"
            min="0"
            max="80"
            value={vibrato}
            onChange={(event) => setVibrato(Number(event.target.value))}
          />
        </label>
        <Latency />
      </div>
      <div className="row">
        {PARTS.map(({ part, label }) => (
          <button
            key={part}
            type="button"
            className="ghost-button"
            aria-pressed={chosen.includes(part)}
            onClick={() => toggle(part)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className="ghost-button"
          aria-pressed={ornate}
          onClick={() => setOrnate((old) => !old)}
        >
          Scoops and falls
        </button>
      </div>
    </section>
  );
}
