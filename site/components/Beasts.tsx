"use client";

import { useCallback, useEffect, useState } from "react";
import type { Creatures } from "@/lib/chimera-kit/creatures.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";

export function Beasts() {
  const [zoo, setZoo] = useState<Creatures | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setZoo(await studio.creatures());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void load();
        seen.disconnect();
      }
    });
    const node = document.getElementById("creatures");
    if (node) seen.observe(node);
    return () => seen.disconnect();
  }, [load]);

  return (
    <section id="creatures">
      <div className="intro">
        <span className="label">Creatures</span>
        <h2>{"Animals, from the same physics."}</h2>
        <p>
          {
            "Change the anatomy and CHIMERA gives a songbird, a seal, an alligator or an elephant. No samples: each call is computed when you press it."
          }
        </p>
      </div>
      <div className="panel">
        {loading ? <p role="status">Loading creature calls...</p> : null}
        {error ? (
          <div role="alert">
            <p>Creature calls could not load. Check your connection and retry.</p>
            <button type="button" className="chip" onClick={() => void load()}>
              Retry creature calls
            </button>
          </div>
        ) : null}
        <div className="row">
          <Latency label="last call, first sample" />
        </div>
        <div className="zoo">
          {(zoo?.list ?? []).map((creature) => (
            <div className="beast" key={creature.id}>
              <h3>{creature.id}</h3>
              <div className="row">
                {creature.calls.map((call) => (
                  <button
                    key={call.id}
                    type="button"
                    className="chip"
                    onClick={() => void studio.call(creature.id, call.id).catch(() => setError(true))}
                  >
                    {call.id}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
