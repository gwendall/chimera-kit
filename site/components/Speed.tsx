"use client";

import { useEffect, useRef, useState } from "react";
import { studio } from "@/lib/studio";
import { useStudio } from "./useStudio";

const WORDS = ["Yes", "No", "Wait", "Hello", "Again", "Stop", "Thanks", "What?"];
const SHOWN = 32;
const SLOTS = Array.from({ length: SHOWN }, (_, slot) => slot);
const BURST = 100;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

interface Burst {
  spoken: number;
  seconds: number;
  median: number;
  worst: number;
}

export function Speed() {
  const { ready, history, speaking } = useStudio();
  const [hit, setHit] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [firing, setFiring] = useState(false);
  const [burst, setBurst] = useState<Burst | null>(null);
  const [text, setText] = useState("Type anything and press Enter.");
  const [asTyped, setAsTyped] = useState(false);
  const lastWord = useRef("");
  const cancelled = useRef(false);

  const press = (index: number) => {
    setHit(index);
    setTimeout(() => setHit((now) => (now === index ? null : now)), 130);
    void studio.speak(WORDS[index] ?? "", { label: WORDS[index] ?? "" }).catch(studio.reportError);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: press only reads state setters and the studio
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("textarea, input")) return;
      const index = Number(event.key) - 1;
      if (index >= 0 && index < WORDS.length) press(index);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fire = async () => {
    if (firing) {
      cancelled.current = true;
      return;
    }
    cancelled.current = false;
    setFiring(true);
    setBurst(null);
    const times: number[] = [];
    const started = performance.now();
    try {
      for (let i = 0; i < BURST && !cancelled.current; i++) {
        await studio.speak(WORDS[i % WORDS.length] ?? "", {
          label: `burst ${i + 1}`,
          onFirstSample: (ms) => times.push(ms),
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const seconds = (performance.now() - started) / 1000;
      studio.stop();
      setBurst({ spoken: times.length, seconds, median: median(times), worst: Math.max(...times, 0) });
    } catch (cause) {
      studio.reportError(cause);
    } finally {
      setFiring(false);
    }
  };

  const speak = () => {
    const line = text.trim();
    if (line) void studio.speak(line, { label: "typed" }).catch(studio.reportError);
  };

  const typed = (value: string) => {
    setText(value);
    if (!asTyped || !/[\s.,!?]$/.test(value)) return;
    const word = value.trim().split(/\s+/).pop() ?? "";
    if (word && word !== lastWord.current) void studio.speak(word, { label: word }).catch(studio.reportError);
    lastWord.current = word;
  };

  const bars = history.slice(-SHOWN);
  const top = Math.max(20, Math.ceil(Math.max(...bars, 0) / 10) * 10);
  const shownValue = hover === null ? null : (bars[hover] ?? null);

  return (
    <section>
      <div className="intro">
        <span className="label">Latency</span>
        <h2>{"Measured on your device, every time."}</h2>
        <p>
          {
            "Each press computes a word from nothing, on this device. Each bar is the time to its first sample. Keys 1 to 8 work too."
          }
        </p>
      </div>
      <div className="panel">
        <div className="keys">
          {WORDS.map((word, index) => (
            <button
              key={word}
              type="button"
              className="key"
              data-hit={hit === index}
              onPointerDown={() => press(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  press(index);
                }
              }}
            >
              <span>{index + 1}</span>
              {word}
            </button>
          ))}
        </div>
        <div
          className="bars"
          role="img"
          aria-label={`The last ${bars.length} first-sample times. Median ${median(bars).toFixed(1)} milliseconds, worst ${Math.max(...bars, 0).toFixed(1)}.`}
          onPointerLeave={() => setHover(null)}
        >
          <span className="bars-scale">{top} ms</span>
          {SLOTS.map((slot) => {
            const at = slot - (SHOWN - bars.length);
            const value = bars[at];
            return (
              <div
                key={slot}
                className="bar-slot"
                onPointerEnter={() => setHover(value === undefined ? null : at)}
              >
                {value === undefined ? null : (
                  <i style={{ height: `${Math.max(2, (value / top) * 100)}%` }} />
                )}
              </div>
            );
          })}
        </div>
        <div className="row readout">
          <span>
            {shownValue === null ? "median" : "this press"}{" "}
            <b>{bars.length ? `${(shownValue ?? median(bars)).toFixed(1)} ms` : "..."}</b>
          </span>
          <span>
            worst <b>{bars.length ? `${Math.max(...bars).toFixed(1)} ms` : "..."}</b>
          </span>
          <span>
            presses <b>{history.length}</b>
          </span>
        </div>
        <div className="row">
          <button type="button" className="go" disabled={!ready} onClick={() => void fire()}>
            {firing ? "Stop the burst" : `Fire ${BURST}`}
          </button>
          {burst ? (
            <span className="latency">
              {burst.spoken} words in <b>{burst.seconds.toFixed(1)} s</b>, median{" "}
              <b>{burst.median.toFixed(1)} ms</b>, worst <b>{burst.worst.toFixed(1)} ms</b>
            </span>
          ) : null}
        </div>
        <textarea
          className="say"
          value={text}
          rows={1}
          spellCheck={false}
          aria-label="Text to speak"
          placeholder="Say something."
          onChange={(event) => typed(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              speak();
            }
          }}
        />
        <div className="row">
          <button type="button" className="ghost-button" onClick={speaking ? () => studio.stop() : speak}>
            {speaking ? "Stop" : ready ? "Speak" : "Warming up"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={asTyped} onChange={(event) => setAsTyped(event.target.checked)} />
            speak each word as I type it
          </label>
        </div>
      </div>
    </section>
  );
}
