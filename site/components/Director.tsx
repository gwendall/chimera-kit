"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Body, Mood, Score } from "@/lib/chimera-kit/index.js";
import { deliver, take } from "@/lib/chimera-kit/index.js";
import { studio } from "@/lib/studio";
import { useStudio } from "./useStudio";

type Word = NonNullable<Score["words"]>[number];

const EXAMPLES = [
  "I never said she stole my money.",
  "You finished all of it by yourself?",
  "We need to talk about tomorrow.",
];
/** What "I never said she stole my money." means with the stress on one word. */
const MEANINGS: Record<string, string> = {
  i: "Someone else said it.",
  never: "Not once. Not ever.",
  said: "I may have implied it.",
  she: "Somebody else stole it.",
  stole: "She did something else with it.",
  my: "It was somebody else's money.",
  money: "She took something else of mine.",
};
const MOODS: Mood[] = [
  "neutral",
  "calm",
  "happy",
  "excited",
  "sad",
  "tired",
  "angry",
  "cold",
  "scared",
  "bored",
  "whisper",
];
const VOICES: { body: "female" | "male" | "child"; name: string }[] = [
  { body: "female", name: "Woman" },
  { body: "male", name: "Man" },
  { body: "child", name: "Child" },
];
/** Semitones drawn above and below the sentence's middle pitch. */
const RANGE = 12;
/** How far a word can be moved, in semitones. */
const LIMIT = 8;
const W = 1000;
const H = 190;

interface Edit {
  stress: boolean;
  semitones: number;
}

const NONE: Edit = { stress: false, semitones: 0 };

/** A word as `take().word()` matches it: letters, digits and apostrophes. */
function clean(text: string): string {
  return text.replace(/[^\p{L}\p{N}']/gu, "");
}

/** For each word, which occurrence of its text it is, counted from 0. */
function occurrences(words: Word[]): number[] {
  const seen = new Map<string, number>();
  return words.map((w) => {
    const key = clean(w.text).toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n;
  });
}

function interval(semitones: number): string {
  return `${semitones > 0 ? "+" : ""}${semitones}st`;
}

/** The plain score with the mood, then each word's stress and pitch: exactly what the code below says. */
function shape(plain: Score, edits: Edit[], mood: Mood, intensity: number): Score {
  const t = take(plain);
  if (mood !== "neutral") t.apply(deliver(mood, intensity));
  const words = plain.words ?? [];
  const nth = occurrences(words);
  words.forEach((w, i) => {
    const edit = edits[i] ?? NONE;
    const text = clean(w.text);
    if (!text || (!edit.stress && !edit.semitones)) return;
    const selection = t.word(text, nth[i]);
    if (edit.stress) selection.emphasize();
    if (edit.semitones) selection.pitch(edit.semitones);
  });
  return t.score;
}

function program(text: string, body: string, words: Word[], edits: Edit[], mood: Mood, intensity: number) {
  const nth = occurrences(words);
  const lines: { text: string; hot: boolean }[] = [
    { text: `const voice = await createVoice({ body: "${body}" });`, hot: false },
    { text: `const t = take(voice.plan(${JSON.stringify(text)}));`, hot: false },
  ];
  if (mood !== "neutral")
    lines.push({ text: `t.apply(deliver("${mood}", ${intensity.toFixed(1)}));`, hot: true });
  words.forEach((w, i) => {
    const edit = edits[i] ?? NONE;
    const word = clean(w.text);
    if (!word || (!edit.stress && !edit.semitones)) return;
    let line = `t.word(${JSON.stringify(word)}${nth[i] ? `, ${nth[i]}` : ""})`;
    if (edit.stress) line += ".emphasize()";
    if (edit.semitones) line += `.pitch("${interval(edit.semitones)}")`;
    lines.push({ text: `${line};`, hot: true });
  });
  if (lines.length === 2) lines.push({ text: "// tap a word, drag the line or pick a mood", hot: false });
  lines.push({ text: "play(voice.stream(t.score), voice.sampleRate);", hot: false });
  return lines;
}

function median(score: Score): number {
  const values = score.pitch.map(([, hz]) => hz).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 200;
}

function wordAt(words: Word[], t: number): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  words.forEach((w, i) => {
    if (!clean(w.text)) return;
    const d = t < w.t0 ? w.t0 - t : t > w.t1 ? t - w.t1 : 0;
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}

export function Director() {
  const { ready, firstSampleMs, speedX, requests } = useStudio();
  const [text, setText] = useState(EXAMPLES[0] as string);
  const [draft, setDraft] = useState(EXAMPLES[0] as string);
  const [body, setBody] = useState<"female" | "male" | "child">("female");
  const [plain, setPlain] = useState<Score | null>(null);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [mood, setMood] = useState<Mood>("neutral");
  const [intensity, setIntensity] = useState(1);
  const [hover, setHover] = useState(-1);
  const [cursor, setCursor] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ i: number; y: number; from: number; moved: boolean } | null>(null);
  const spoken = useRef<Score | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    void studio.plan(text, body as Body).then((score) => {
      if (!live) return;
      setPlain(score);
      setEdits((old) => (old.length === (score.words?.length ?? 0) ? old : []));
    });
    return () => {
      live = false;
    };
  }, [ready, text, body]);

  const words = plain?.words ?? [];
  const score = useMemo(
    () => (plain ? shape(plain, edits, mood, intensity) : null),
    [plain, edits, mood, intensity],
  );
  const shown = score?.words ?? [];

  const speak = (next: Score | null = score) => {
    if (!next) return;
    spoken.current = next;
    void studio.speak(next, { body: body as Body, label: "director" });
  };

  // A change made by a tap plays once the new score exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: plays on the score's change only
  useEffect(() => {
    if (!pending.current || !score) return;
    pending.current = false;
    speak(score);
  }, [score]);

  const change = (apply: () => void) => {
    pending.current = true;
    apply();
  };

  // The playhead, while this score is the one sounding.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const reading = studio.read();
      setCursor(reading.mode === "live" && reading.score === spoken.current ? reading.t : null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const span = Math.max(plain?.duration ?? 1, score?.duration ?? 1);
  const center = plain ? median(plain) : 200;
  const y = (hz: number) =>
    Math.min(H - 3, Math.max(3, H / 2 - ((12 * Math.log2(hz / center)) / RANGE) * (H / 2)));
  const path = (s: Score | null) =>
    s?.pitch
      .map(([t, hz], i) => `${i ? "L" : "M"}${((t / span) * W).toFixed(1)} ${y(hz).toFixed(1)}`)
      .join("") ?? "";

  const toggle = (i: number) =>
    change(() =>
      setEdits((old) => {
        const next = words.map((_, k) => old[k] ?? NONE);
        const current = next[i] ?? NONE;
        next[i] = { ...current, stress: !current.stress };
        return next;
      }),
    );

  // Arrow keys on a word chip do what a drag on the curve does, a semitone at a time.
  const nudge = (i: number, by: number) =>
    change(() =>
      setEdits((old) => {
        const next = words.map((_, k) => old[k] ?? NONE);
        const current = next[i] ?? NONE;
        const semitones = Math.max(-LIMIT, Math.min(LIMIT, current.semitones + by));
        next[i] = { ...current, semitones };
        return next;
      }),
    );

  const timeAt = (clientX: number) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return 0;
    return ((clientX - box.left) / box.width) * span;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = draft.trim();
    if (!next) return;
    if (next === text) speak();
    else {
      pending.current = true;
      setEdits([]);
      setText(next);
    }
  };

  // The planner lowercases its words ("i"): show them as typed when the two line up.
  const labels = useMemo(() => {
    const typed = text.split(/\s+/).map(clean).filter(Boolean);
    const planned = words.map((w) => clean(w.text));
    const match = typed.length === planned.filter(Boolean).length;
    let next = 0;
    return planned.map((word) => (word && match ? (typed[next++] ?? word) : word));
  }, [text, words]);
  const stressed = words
    .map((w, i) => (edits[i]?.stress ? clean(w.text).toLowerCase() : null))
    .filter(Boolean);
  const bent = edits.some((e) => e?.semitones);
  const meaning =
    text === EXAMPLES[0] && stressed.length === 1 && !bent && mood === "neutral"
      ? MEANINGS[stressed[0] as string]
      : null;
  const lines = program(text, body, words, edits, mood, intensity);

  return (
    <div className="panel director">
      <div className="field">
        <span className="field-name">Text</span>
        <div className="curve">
          <form className="sentence-input" onSubmit={submit}>
            <input
              aria-label="Sentence to speak"
              value={draft}
              maxLength={140}
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="go" disabled={!ready}>
              Speak
            </button>
          </form>
          <div className="examples">
            <span>Try</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setDraft(example);
                  if (example === text) speak();
                  else {
                    pending.current = true;
                    setEdits([]);
                    setText(example);
                  }
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="field">
        <span className="field-name">Stress</span>
        <div className="words">
          {words.map((w, i) =>
            clean(w.text) ? (
              <button
                key={`${w.text}-${w.t0}`}
                type="button"
                className="word"
                aria-pressed={edits[i]?.stress ?? false}
                data-hover={hover === i}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(-1)}
                onClick={() => toggle(i)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  nudge(i, event.key === "ArrowUp" ? 1 : -1);
                }}
                aria-describedby="director-hint"
              >
                {labels[i]}
                {edits[i]?.semitones ? <sup>{interval(edits[i]?.semitones ?? 0)}</sup> : null}
              </button>
            ) : null,
          )}
          {!words.length ? <span className="kicker">Loading the voice...</span> : null}
        </div>
      </div>

      <div className="field">
        <span className="field-name">Pitch</span>
        <div className="curve">
          <svg
            ref={svg}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="The sentence's pitch over time. Drag a word up or down to move it; tap it to stress it."
            onPointerDown={(event) => {
              const i = wordAt(shown, timeAt(event.clientX));
              if (i < 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { i, y: event.clientY, from: edits[i]?.semitones ?? 0, moved: false };
              setHover(i);
            }}
            onPointerMove={(event) => {
              const held = drag.current;
              if (!held) {
                if (event.pointerType === "mouse") setHover(wordAt(shown, timeAt(event.clientX)));
                return;
              }
              const box = svg.current?.getBoundingClientRect();
              if (!box) return;
              const dy = held.y - event.clientY;
              if (Math.abs(dy) > 4) held.moved = true;
              if (!held.moved) return;
              const perSemitone = box.height / (2 * RANGE);
              const semitones = Math.max(
                -LIMIT,
                Math.min(LIMIT, Math.round((held.from + dy / perSemitone) * 2) / 2),
              );
              setEdits((old) => {
                const next = words.map((_, k) => old[k] ?? NONE);
                next[held.i] = { ...(next[held.i] ?? NONE), semitones };
                return next;
              });
            }}
            onPointerUp={() => {
              const held = drag.current;
              drag.current = null;
              if (!held) return;
              if (held.moved) speak();
              else toggle(held.i);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onPointerLeave={() => {
              if (!drag.current) setHover(-1);
            }}
          >
            {shown.map((w, i) => {
              const x0 = (w.t0 / span) * W;
              const x1 = (w.t1 / span) * W;
              const on = edits[i]?.stress;
              return (
                <g key={`${w.text}-${w.t0}`}>
                  {on || hover === i ? (
                    <rect
                      x={x0}
                      y={0}
                      width={Math.max(x1 - x0, 1)}
                      height={H}
                      style={{ fill: on ? "var(--accent-soft)" : "var(--line)" }}
                    />
                  ) : null}
                  <line
                    x1={x0}
                    x2={x0}
                    y1={0}
                    y2={H}
                    style={{ stroke: "var(--line-strong)" }}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
            <line
              x1={0}
              x2={W}
              y1={H / 2}
              y2={H / 2}
              style={{ stroke: "var(--line-strong)" }}
              strokeDasharray="2 6"
              vectorEffect="non-scaling-stroke"
            />
            {edits.some((e) => e?.stress || e?.semitones) || mood !== "neutral" ? (
              <path
                d={path(plain)}
                fill="none"
                style={{ stroke: "var(--faint)" }}
                strokeWidth="1.5"
                strokeDasharray="5 5"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <path
              d={path(score)}
              fill="none"
              style={{ stroke: "var(--accent)" }}
              strokeWidth="2.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {cursor !== null ? (
              <line
                x1={(cursor / span) * W}
                x2={(cursor / span) * W}
                y1={0}
                y2={H}
                style={{ stroke: "var(--ink)" }}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          <div className="axis" aria-hidden="true">
            {shown.map((w, i) =>
              clean(w.text) ? (
                <span
                  key={`${w.text}-${w.t0}`}
                  data-on={edits[i]?.stress ?? false}
                  style={{ left: `${(w.t0 / span) * 100}%`, width: `${((w.t1 - w.t0) / span) * 100}%` }}
                >
                  {labels[i]}
                </span>
              ) : null,
            )}
          </div>
          <div className="legend">
            <span>
              <i />
              what it says
            </span>
            {edits.some((e) => e?.stress || e?.semitones) || mood !== "neutral" ? (
              <span>
                <i className="planned" />
                before your changes
              </span>
            ) : null}
            <span id="director-hint">
              Drag a word up or down to move its pitch, or use the arrow keys on it. Tap it to stress it.
            </span>
          </div>
        </div>
      </div>

      <div className="field">
        <span className="field-name">Mood</span>
        <div className="words">
          {MOODS.map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              aria-pressed={mood === m}
              onClick={() => change(() => setMood(m))}
            >
              {m}
            </button>
          ))}
          {mood !== "neutral" ? (
            <label className="slider">
              intensity
              <input
                type="range"
                min={0.2}
                max={2}
                step={0.1}
                value={intensity}
                onChange={(event) => setIntensity(Number(event.target.value))}
                onPointerUp={() => speak()}
                onKeyUp={() => speak()}
              />
              {intensity.toFixed(1)}
            </label>
          ) : null}
        </div>
      </div>

      <div className="field">
        <span className="field-name">Voice</span>
        <div className="row">
          <div className="segmented">
            {VOICES.map((v) => (
              <button
                key={v.body}
                type="button"
                aria-pressed={body === v.body}
                onClick={() =>
                  change(() => {
                    setBody(v.body);
                  })
                }
              >
                {v.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              change(() => {
                setEdits([]);
                setMood("neutral");
                setIntensity(1);
              })
            }
          >
            Reset
          </button>
        </div>
      </div>

      <div className="meaning" aria-live="polite">
        {meaning ? `"${meaning}"` : null}
      </div>

      <div className="row readout">
        <span>
          first sound <b>{firstSampleMs === null ? "..." : `${firstSampleMs.toFixed(1)} ms`}</b> after the
          click
        </span>
        <span>
          computed <b>{speedX === null ? "..." : `${speedX.toFixed(0)}x`}</b> faster than real time
        </span>
        <span>
          <b>{requests}</b> network requests while speaking
        </span>
      </div>

      <pre className="code">
        {lines.map((line) => (
          <span key={line.text} className={line.hot ? "hot" : line.text.startsWith("//") ? "dim" : undefined}>
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
