"use client";

import { useEffect, useRef, useState } from "react";
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
const TOTAL = BEATS.reduce((a, b) => a + b, 0);
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
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(-1);
  const [error, setError] = useState("");
  const run = useRef<AbortController | null>(null);
  const frame = useRef(0);
  const head = useRef<SVGGElement>(null);
  const trail = useRef<SVGRectElement>(null);
  const drag = useRef<{ index: number; startY: number; startMidi: number } | null>(null);

  useEffect(
    () => () => {
      run.current?.abort();
      run.current = null;
      cancelAnimationFrame(frame.current);
    },
    [],
  );

  const stop = () => {
    run.current?.abort();
    run.current = null;
    cancelAnimationFrame(frame.current);
    studio.stop();
    setPlaying(false);
    setCurrent(-1);
  };

  const sing = async (notes = midi) => {
    stop();
    studio.unlock();
    const next = new AbortController();
    run.current = next;
    setPlaying(true);
    setError("");
    if (head.current) head.current.style.transform = "translateX(0px)";
    if (trail.current) trail.current.style.transform = "scaleX(0)";
    const song: Song = {
      lyrics: LYRICS,
      bpm: 92,
      // All bodies land the vowel on this beat, after their opening consonant.
      t0: 0.12,
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
    const onStart = (elapsed: () => number) => {
      if (next.signal.aborted || run.current !== next) return;
      let last = -1;
      const tick = () => {
        if (next.signal.aborted || run.current !== next) return;
        const beat = Math.max(0, ((elapsed() - (song.t0 ?? 0)) * song.bpm) / 60);
        const position = Math.min(1, beat / TOTAL);
        if (head.current) head.current.style.transform = `translateX(${position * 1000}px)`;
        if (trail.current) trail.current.style.transform = `scaleX(${position})`;
        let end = 0;
        const note = BEATS.findIndex((length) => {
          end += length;
          return beat < end;
        });
        if (note !== last) {
          setCurrent(note);
          last = note;
        }
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    };
    try {
      const parts = await Promise.all(
        lines.map(async ({ input, body }) => ({ input: await shaped(input, body), body })),
      );
      next.signal.throwIfAborted();
      const lead = parts[0];
      if (parts.length === 1 && lead) {
        const playback = await studio.speak(lead.input, {
          body: "female",
          label: "singing",
          signal: next.signal,
          onStart,
        });
        await playback.done;
      } else {
        await studio.parts(parts, { signal: next.signal, onStart });
      }
    } catch (cause) {
      if (!next.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not play the song.");
    } finally {
      if (run.current === next) {
        cancelAnimationFrame(frame.current);
        run.current = null;
        setPlaying(false);
        setCurrent(-1);
      }
    }
  };
  const toggle = (part: Part) =>
    setChosen((old) => (old.includes(part) ? old.filter((p) => p !== part) : [...old, part]));

  let beat = 0;
  return (
    <section id="sing">
      <div className="intro">
        <span className="label">Singing</span>
        <h2>{"It sings, in harmony."}</h2>
        <p>
          {
            "Give it lyrics and notes and the same engine sings them. Drag a note to change the melody. Add a part and a second simulated singer joins in, on a harmony worked out from your notes."
          }
        </p>
      </div>
      <div className="panel">
        <svg
          className="roll"
          viewBox="0 0 1000 250"
          preserveAspectRatio="none"
          role="img"
          aria-label="Melody editor"
          data-playing={playing}
        >
          <rect ref={trail} className="song-trail" width="1000" height="250" />
          {BEATS.map((length, i) => {
            const note = midi[i] ?? 60;
            const x = (beat / TOTAL) * 1000;
            const width = (length / TOTAL) * 1000 - 4;
            beat += length;
            const y = ((TOP - note) / ROWS) * 250;
            return (
              <g
                // biome-ignore lint/suspicious/noArrayIndexKey: notes never reorder, dragging only changes their pitch
                key={`${i}-${length}`}
                className="song-note"
                data-active={current === i}
                data-played={playing && current > i}
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
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                <rect x={x} y={y} width={width} height={250 / ROWS - 2} fill="var(--accent)" rx="2" />
              </g>
            );
          })}
          <g ref={head} className="song-head">
            <line x1="0" y1="0" x2="0" y2="250" />
            <circle cx="0" cy="5" r="4" />
          </g>
        </svg>
        <p className="song-lyrics">
          {SYLLABLES.map((syllable, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: each syllable stays on its original note
            <span key={i} data-active={current === i}>
              {syllable.replace(/-$/, "")}
              {syllable.endsWith("-") ? "" : " "}
            </span>
          ))}
        </p>
        <div className="row">
          <button type="button" className="go sing-transport" onClick={playing ? stop : () => void sing()}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d={playing ? "M2 2h10v10H2z" : "M3 1l10 6-10 6z"} fill="currentColor" />
            </svg>
            {playing ? "Stop" : "Sing it"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              stop();
              setMidi(START);
            }}
          >
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
        {error ? <p role="alert">{error}</p> : null}
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
      </div>
    </section>
  );
}
