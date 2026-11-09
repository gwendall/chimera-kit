"use client";

import { Throat } from "./Throat";
import { useStudio } from "./useStudio";

function Cell({ value, label, wide }: { value: string; label: string; wide?: boolean }) {
  return (
    <div className={wide ? "cell secondary" : "cell"}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** Everything on this panel is measured in this browser, as it happens. */
export function Monitor() {
  const { firstSampleMs, speedX, voices, requests, deviceMs, engineLoadMs } = useStudio();
  return (
    <>
      <div className="telemetry" aria-live="off">
        <Cell
          value={firstSampleMs === null ? "..." : `${firstSampleMs.toFixed(1)} ms`}
          label="first sample"
        />
        <Cell value={speedX === null ? "..." : `${speedX.toFixed(1)}x`} label="real time" />
        <Cell value={String(voices)} label={voices === 1 ? "voice now" : "voices now"} />
        <Cell value={String(requests)} label="requests while speaking" wide />
        <Cell
          value={deviceMs === null ? "..." : `+${deviceMs.toFixed(0)} ms`}
          label="your audio hardware"
          wide
        />
        <Cell
          value={engineLoadMs === null ? "..." : `${engineLoadMs.toFixed(0)} ms`}
          label="engine load"
          wide
        />
      </div>
      <Throat />
    </>
  );
}
