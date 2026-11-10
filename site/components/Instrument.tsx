"use client";

import { useEffect, useRef, useState } from "react";
import { createInstrument, type Instrument as Played } from "@/lib/chimera-kit/live.js";
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
  const pad = useRef<HTMLButtonElement>(null);
  const played = useRef<Played | null>(null);
  const mounted = useRef(true);
  const loading = useRef<Promise<Played> | null>(null);
  const point = useRef<Point | null>(null);
  const vowel = useRef("a");
  const beating = useRef(false);
  const keyboard = useRef(false);
  const keyboardPoint = useRef<Point>({ x: 0.5, y: 0.5 });
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [shown, setShown] = useState<Point | null>(null);
  const [held, setHeld] = useState(false);
  const [chosen, setChosen] = useState("a");
  const [beat, setBeat] = useState(false);
  const [quantumMs, setQuantumMs] = useState<number | null>(null);

  const failed = () => {
    loading.current = null;
    played.current?.free();
    played.current = null;
    beating.current = false;
    keyboard.current = false;
    point.current = null;
    setBeat(false);
    setShown(null);
    setHeld(false);
    setQuantumMs(null);
    setState("failed");
  };

  const load = () => {
    if (!loading.current) {
      const { context, output } = studio.route();
      setState("loading");
      loading.current = createInstrument({ context, destination: output, body: "female" }).then(
        (instrument) => {
          if (!mounted.current) {
            instrument.free();
            return instrument;
          }
          instrument.vowel(vowel.current);
          played.current = instrument;
          setQuantumMs((128 / context.sampleRate) * 1000);
          setState("ready");
          return instrument;
        },
      );
    }
    return loading.current;
  };

  useEffect(() => {
    mounted.current = true;
    let frame = 0;
    const tick = () => {
      if (point.current || beating.current) studio.hold("live");
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const blur = () => {
      keyboard.current = false;
      point.current = null;
      setShown(null);
      setHeld(false);
      played.current?.noteOff();
    };
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      keyboard.current = false;
      point.current = null;
      beating.current = false;
      window.removeEventListener("blur", blur);
      cancelAnimationFrame(frame);
      played.current?.beat.stop();
      played.current?.noteOff();
      played.current?.free();
    };
  }, []);

  const at = (event: React.PointerEvent): Point => {
    const box = (pad.current as HTMLButtonElement).getBoundingClientRect();
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
    setHeld(true);
    setShown(p);
    void load()
      .then((instrument) => {
        const now = point.current;
        if (!now) return;
        instrument.shape({ jaw: jawAt(now) });
        instrument.noteOn(midiAt(now));
      })
      .catch(failed);
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
    setHeld(false);
    setShown(null);
    played.current?.noteOff();
  };

  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      keyboard.current = false;
      release();
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const p = keyboardPoint.current;
      const next = {
        x: clamp(p.x + (event.key === "ArrowRight" ? 1 / 24 : event.key === "ArrowLeft" ? -1 / 24 : 0)),
        y: clamp(p.y + (event.key === "ArrowUp" ? 0.05 : event.key === "ArrowDown" ? -0.05 : 0)),
      };
      keyboardPoint.current = next;
      setShown(next);
      if (keyboard.current) {
        point.current = next;
        played.current?.bend(midiAt(next));
        played.current?.shape({ jaw: jawAt(next) });
      }
      return;
    }
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || keyboard.current) return;
    keyboard.current = true;
    setHeld(true);
    if (!beating.current) studio.stop();
    point.current = keyboardPoint.current;
    setShown(point.current);
    void load()
      .then((instrument) => {
        if (!keyboard.current || !point.current) return;
        instrument.shape({ jaw: jawAt(point.current) });
        instrument.noteOn(midiAt(point.current));
      })
      .catch(failed);
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
    void load()
      .then((instrument) => {
        if (!beating.current) {
          instrument.beat.stop();
          return;
        }
        instrument.beat.steps(PATTERN);
        instrument.beat.start({ bpm: 96 });
      })
      .catch(failed);
  };

  const hit = (name: string) => {
    void load()
      .then((instrument) => instrument.beat.hit(name))
      .catch(failed);
  };

  return (
    <section id="instrument">
      <div className="intro">
        <span className="label">Instrument</span>
        <h2>{"Play the voice live."}</h2>
        <p>
          {
            "The same throat, played by hand: across the pad is two octaves of pitch, up opens the jaw. Pick a vowel while you hold. It also beatboxes, with lips and tongue rather than samples."
          }
        </p>
      </div>
      <div className="panel">
        <button
          type="button"
          ref={pad}
          className="pad"
          aria-label={`Live voice pad: MIDI ${Math.round(midiAt(shown ?? keyboardPoint.current))}, jaw ${jawAt(shown ?? keyboardPoint.current).toFixed(1)} cm`}
          aria-describedby="instrument-keys"
          data-playing={held}
          onKeyDown={keyDown}
          onKeyUp={(event) => {
            if (event.key === " " || event.key === "Enter") {
              keyboard.current = false;
              release();
            }
          }}
          onBlur={() => {
            keyboard.current = false;
            release();
          }}
          onPointerEnter={() => void load().catch(failed)}
          onPointerDown={press}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={release}
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
        </button>
        <p id="instrument-keys" className="kicker">
          Keyboard: hold Space or Enter to sing. Left/right changes pitch; up/down opens or closes the jaw.
          Escape stops the note.
        </p>
        {state === "failed" ? (
          <div role="alert">
            <p>The live voice could not load. Check your connection and retry.</p>
            <button type="button" className="chip" onClick={() => void load().catch(failed)}>
              Retry live voice
            </button>
          </div>
        ) : null}
        <div className="row">
          {VOWELS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              aria-pressed={chosen === v}
              onClick={() => pick(v)}
            >
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
      </div>
    </section>
  );
}
