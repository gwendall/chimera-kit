"use client";

import { useEffect } from "react";
import { Anyone } from "@/components/Anyone";
import { Beasts } from "@/components/Beasts";
import { Direct } from "@/components/Direct";
import { Hero } from "@/components/Hero";
import { Layers } from "@/components/Layers";
import { Live } from "@/components/Live";
import { Sing } from "@/components/Sing";
import { Throat } from "@/components/Throat";
import { studio } from "@/lib/studio";

export default function Page() {
  useEffect(() => {
    void studio.load();
    // pointerdown doesn't count as a gesture on iOS: these do. A scroll's touchend is refused, so keep trying.
    const events = ["pointerup", "touchend", "click", "keydown"];
    const wake = () => {
      if (!studio.unlock()) return;
      for (const name of events) document.removeEventListener(name, wake, true);
    };
    for (const name of events) document.addEventListener(name, wake, true);
    return () => {
      for (const name of events) document.removeEventListener(name, wake, true);
    };
  }, []);

  return (
    <main className="page">
      <aside className="pane">
        <Throat />
      </aside>
      <div className="story">
        <Hero />
        <Direct />
        <Anyone />
        <Sing />
        <Beasts />
        <Live />
        <Layers />
        <footer>
          Built on <a href="https://github.com/jamesondh/chimera-vocal-synth">CHIMERA</a>, a physical model of
          the voice. It does not sound natural and it is not trying to. Nothing you type leaves this page.
        </footer>
      </div>
    </main>
  );
}
