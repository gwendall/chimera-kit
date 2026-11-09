"use client";

import { useEffect } from "react";
import { Agent } from "@/components/Agent";
import { Anyone } from "@/components/Anyone";
import { Beasts } from "@/components/Beasts";
import { Consonants } from "@/components/Consonants";
import { Crowd } from "@/components/Crowd";
import { Direct } from "@/components/Direct";
import { Engines } from "@/components/Engines";
import { Layers } from "@/components/Layers";
import { Live } from "@/components/Live";
import { Monitor } from "@/components/Monitor";
import { Sing } from "@/components/Sing";
import { Speed } from "@/components/Speed";
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
        <Monitor />
      </aside>
      <div className="story">
        <Direct />
        <Speed />
        <Anyone />
        <Sing />
        <Consonants />
        <Crowd />
        <Beasts />
        <Live />
        <Agent />
        <Engines />
        <Layers />
        <footer>
          The voice is <a href="https://github.com/jamesondh/chimera-vocal-synth">CHIMERA</a> by{" "}
          <a href="https://github.com/jamesondh">Jameson Hodge</a>, MIT licensed. intone is the layer that
          puts it in products. It does not sound natural and it is not trying to. Nothing you type leaves this
          page.
        </footer>
      </div>
    </main>
  );
}
