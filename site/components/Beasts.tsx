"use client";

import { useEffect, useState } from "react";
import type { Creatures } from "@/lib/intone/creatures.js";
import { studio } from "@/lib/studio";
import { Latency } from "./Latency";

export function Beasts() {
  const [zoo, setZoo] = useState<Creatures | null>(null);

  useEffect(() => {
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void studio.creatures().then(setZoo);
        seen.disconnect();
      }
    });
    const node = document.getElementById("creatures");
    if (node) seen.observe(node);
    return () => seen.disconnect();
  }, []);

  return (
    <section id="creatures">
      <span className="kicker">Not only people, straight from CHIMERA</span>
      <h2>
        Same physics.
        <br />
        <em>Other</em> animals.
      </h2>
      <p>
        CHIMERA simulates anatomy, so changing the anatomy gives you a bird, a seal, an alligator or an
        elephant. None of these are samples. Each call is computed when you press it.
      </p>
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
                  onClick={() => void studio.call(creature.id, call.id)}
                >
                  {call.id}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
