"use client";

import { Fragment, useEffect, useRef } from "react";
import type { Score } from "@/lib/chimera-kit/index.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";
import { useStudio } from "./useStudio";

/** Every consonant of English, by how the airway makes it. */
const GROUPS: { name: string; sounds: string[] }[] = [
  { name: "Stops", sounds: ["p", "b", "t", "d", "k", "g"] },
  { name: "Nasals", sounds: ["m", "n", "ŋ"] },
  { name: "Hisses", sounds: ["f", "v", "θ", "ð", "s", "z", "ʃ", "ʒ", "h"] },
  { name: "Affricates", sounds: ["tʃ", "dʒ"] },
  { name: "Glides", sounds: ["l", "ɹ", "w", "j"] },
];

/** Reaches all twenty-four. */
const SENTENCE = "Young Beth quickly fixed my azure vase, and then watched John's hungry sheep graze.";

const VOWEL = "ɑ";
const LEAD = 0.06;
const OPEN = 0.26;
const HELD = 0.13;

/** One consonant between two vowels, the only setting in which most of them can be heard at all. */
function between(sound: string): Score {
  const edges = [0, LEAD, LEAD + OPEN, LEAD + OPEN + HELD, LEAD + 2 * OPEN + HELD];
  const [start, on, closed, open, end] = edges as [number, number, number, number, number];
  return {
    duration: end + LEAD,
    sounds: [
      { sound: "_", t0: start, t1: on },
      { sound: VOWEL, t0: on, t1: closed },
      { sound, t0: closed, t1: open },
      { sound: VOWEL, t0: open, t1: end },
      { sound: "_", t0: end, t1: end + LEAD },
    ],
    pitch: [
      [0, 205],
      [end + LEAD, 170],
    ],
  };
}

export function Consonants() {
  const { ready } = useStudio();
  const cells = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let lit: HTMLButtonElement | undefined;
    let frame = 0;
    const tick = () => {
      const now = studio.soundNow();
      const cell = now === null ? undefined : cells.current.get(now);
      if (cell !== lit) {
        lit?.removeAttribute("data-on");
        cell?.setAttribute("data-on", "");
        lit = cell;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <section>
      <div className="intro">
        <span className="label">Consonants</span>
        <h2>{"Every consonant is simulated."}</h2>
        <p>
          {
            "A stop is a closure and a burst, a hiss is air forced through a gap. None of them is a recording. Press one to hear it between two vowels, or say the sentence that uses all twenty-four."
          }
        </p>
      </div>
      <div className="panel">
        <div className="row">
          <button
            type="button"
            className="go"
            onClick={() => void studio.speak(SENTENCE, { body: "female", label: "consonants" })}
          >
            {ready ? "Say the sentence" : "Loading..."}
          </button>
          <Latency />
        </div>
        <div className="phones">
          {GROUPS.map(({ name, sounds }) => (
            <Fragment key={name}>
              <span>{name}</span>
              <div>
                {sounds.map((sound) => (
                  <button
                    key={sound}
                    type="button"
                    aria-label={`Hear ${sound}`}
                    ref={(node) => {
                      if (node) cells.current.set(sound, node);
                      else cells.current.delete(sound);
                    }}
                    onClick={() => void studio.speak(between(sound), { body: "female", label: sound })}
                  >
                    {sound}
                  </button>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
