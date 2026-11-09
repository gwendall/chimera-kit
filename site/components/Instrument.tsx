"use client";

import { useEffect, useRef, useState } from "react";
import { createInstrument, type Instrument as Played } from "@/lib/intone/live.js";
import { studio } from "@/lib/studio";

/** Two octaves across the pad, from C3. */
const LOW = 48;
const HIGH = 72;
/** The jaw's opening at the incisors, from the bottom of the pad to the top (cm). */
const JAW_SHUT = 0.35;
const JAW_WIDE = 2.1;
const VOWELS = ["i", "e", "a", "o", "u", "y"];
/** Kick, hat, snare, hat: one bar of eighths, the symbols the sequencer reads. */
const PATTERN = "B t Pf t B B Pf t";
const HITS = ["Kick", "Snare", "Hi-hat", "Lip pop", "Tongue click"];

interface Point {
  x: number;
  y: number;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const midiAt = (p: Point) => LOW + p.x * (HIGH - LOW);
const jawAt = (p: Point) => JAW_SHUT + p.y * (JAW_WIDE - JAW_SHUT);

export function Instrument() {
  const pad = useRef<HTMLDivElement>(null);
  const played = useRef<Played | null>(null);
  const loading = useRef<Promise<Played> | null>(null);
  const point = useRef<Point | null>(null);
  const vowel = useRef("a");
  const beating = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [shown, setShown] = useState<Point | null>(null);
  const [chosen, setChosen] = useState("a");
  const [beat, setBeat] = useState(false);
  const [quantumMs, setQuantumMs] = useState<number | null>(null);

  const load = () => {
    if (!loading.current) {
      const { context, output } = studio.route();
      setState("loading");
      loading.current = createInstrument({ context, destination: output, body: "female" }).then(
        (instrument) => {
          instrument.vowel(vowel.current);
          played.current = instrument;
          setQuantumMs((128 / context.sampleRate) * 1000);
          setState("ready");
          return instrument;
        },
        (error: unknown) => {
          loading.current = null;
          setState("failed");
          throw error;
        },
      );
    }
    return loading.current;
  };

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (point.current || beating.current) studio.hold("live");
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      played.current?.beat.stop();
      played.current?.noteOff();
    };
  }, []);

  const at = (event: React.PointerEvent): Point => {
    const box = (pad.current as HTMLDivElement).getBoundingClientRect();
    return {
      x: clamp((event.clientX - box.left) / box.width),
      y: clamp(1 - (event.clientY - box.top) / box.height),
    };
  };

  const press = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!beating.current) studio.stop();
    const p = at(event);
    point.current = p;
    setShown(p);
    void load().then((instrument) => {
      const now = point.current;
      if (!now) return;
      instrument.shape({ jaw: jawAt(now) });
      instrument.noteOn(midiAt(now));
    });
  };

  const move = (event: React.PointerEvent) => {
    if (!point.current) return;
    const p = at(event);
    point.current = p;
    setShown(p);
    played.current?.bend(midiAt(p));
    played.current?.shape({ jaw: jawAt(p) });
  };

  const release = () => {
    if (!point.current) return;
    point.current = null;
    setShown(null);
    played.current?.noteOff();
  };

  const pick = (v: string) => {
    vowel.current = v;
    setChosen(v);
    played.current?.vowel(v);
    const p = point.current;
    if (p) played.current?.shape({ jaw: jawAt(p) });
  };

  const toggleBeat = () => {
    const next = !beating.current;
    beating.current = next;
    setBeat(next);
    if (next) studio.stop();
    void load().then((instrument) => {
      if (!beating.current) {
        instrument.beat.stop();
        return;
      }
      instrument.beat.steps(PATTERN);
      instrument.beat.start({ bpm: 96 });
    });
  };

  const hit = (name: string) => {
    void load().then((instrument) => instrument.beat.hit(name));
  };

  return (
    <section>
      <span className="kicker">Play it</span>
      <h2>
        Not a recording.
        <br />
        <em>An instrument.</em>
      </h2>
      <p>
        The same throat, held open and played by hand. Press and drag on the pad: across is two octaves of
        pitch, up opens the jaw. Pick a vowel while you hold. The same engine also beatboxes, with lips and
        tongue rather than samples.
      </p>
      <div
        ref={pad}
        className="pad"
        role="application"
        aria-label="A pad: press to sing, drag across for pitch and up to open the jaw"
        onPointerEnter={() => void load().catch(() => {})}
        onPointerDown={press}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
      >
        {shown ? (
          <span className="pad-dot" style={{ left: `${shown.x * 100}%`, top: `${(1 - shown.y) * 100}%` }} />
        ) : (
          <span className="pad-hint">
            {state === "loading"
              ? "Loading the throat..."
              : state === "failed"
                ? "No audio worklet here"
                : "Press and drag"}
          </span>
        )}
      </div>
      <div className="row">
        {VOWELS.map((v) => (
          <button key={v} type="button" className="chip" aria-pressed={chosen === v} onClick={() => pick(v)}>
            {v}
          </button>
        ))}
        {quantumMs === null ? null : (
          <span className="latency">
            the engine reacts within <b>{quantumMs.toFixed(1)} ms</b>
          </span>
        )}
      </div>
      <div className="row">
        <button type="button" className="go" aria-pressed={beat} onClick={toggleBeat}>
          {beat ? "Stop the beat" : "Start a beat"}
        </button>
        {HITS.map((name) => (
          <button key={name} type="button" className="ghost-button" onClick={() => hit(name)}>
            {name}
          </button>
        ))}
      </div>
    </section>
  );
}
