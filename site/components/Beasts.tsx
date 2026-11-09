"use client";

import { useEffect, useState } from "react";
import type { Creatures } from "@/lib/intone/creatures.js";
import { studio } from "@/lib/studio";

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
      <span className="kicker">Not only people</span>
      <h2>
        Same physics.
        <br />
        <em>Longer</em> throats.
      </h2>
      <p>
        Change the anatomy and the same simulation gives you a bird, a seal, an alligator or an elephant.
        These are not samples either.
      </p>
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
