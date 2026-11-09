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
