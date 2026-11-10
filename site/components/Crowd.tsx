"use client";

import { useEffect, useRef, useState } from "react";
import type { Scene } from "@/lib/crowd";
import { type CrowdReport, studio } from "@/lib/studio";

const SCENES: { id: Scene; name: string }[] = [
  { id: "hubbub", name: "Hubbub" },
  { id: "choir", name: "Choir" },
  { id: "dialogue", name: "Dialogue" },
];

function percentile(values: number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
}

export function Crowd() {
  const [voices, setVoices] = useState(8);
  const [report, setReport] = useState<CrowdReport | null>(null);
  const [scene, setScene] = useState<Scene>("hubbub");
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        studio.warmCrowd(4);
        seen.disconnect();
      }
    });
    seen.observe(node);
    return () => seen.disconnect();
  }, []);

  const running = report?.running ?? false;
  const start = (name: Scene) => {
    setScene(name);
    void studio.crowd(name, voices, setReport).catch((cause: unknown) => {
      setReport((old) => (old ? { ...old, running: false } : null));
      studio.reportError(cause);
    });
  };

  const first = report?.firstMs ?? [];
  const gaps = report && report.audioSeconds > 0 ? (report.gapSeconds / report.audioSeconds) * 100 : null;
  const cells: [string, string][] = [
    [String(report?.peak ?? 0), "voices at once, at the peak"],
    [first.length ? `${percentile(first, 0.5).toFixed(0)} ms` : "...", "median first sample"],
    [first.length ? `${Math.max(...first).toFixed(0)} ms` : "...", "worst first sample"],
    [gaps === null ? "..." : `${gaps.toFixed(gaps < 10 ? 2 : 0)} %`, "of the audio arrived late"],
  ];

  return (
    <section ref={section}>
      <div className="intro">
        <span className="label">Crowds</span>
        <h2>{"Dozens of voices at once."}</h2>
        <p>
          {
            "Each voice runs in its own worker with its own body, mixed live. Raise the count until your device cannot keep up: the numbers show when."
          }
        </p>
      </div>
      <div className="panel">
        <label className="slider wide">
          {voices} {voices === 1 ? "voice" : "voices"}
          <input
            type="range"
            min="1"
            max="24"
            value={voices}
            disabled={running}
            aria-label="Number of voices"
            onChange={(event) => setVoices(Number(event.target.value))}
            onPointerUp={() => studio.warmCrowd(voices)}
          />
        </label>
        <div className="row">
          {SCENES.map(({ id, name }) => (
            <button
              key={id}
              type="button"
              className="chip"
              aria-pressed={running && scene === id}
              disabled={running}
              onClick={() => start(id)}
            >
              {name}
            </button>
          ))}
          {running ? (
            <button type="button" className="ghost-button" onClick={() => studio.stop()}>
              Stop
            </button>
          ) : null}
        </div>
        <div className="stats">
          {cells.map(([value, label]) => (
            <div className="stat" key={label}>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
