"use client";

import { useStudio } from "./useStudio";

/** The measured time of whatever was just triggered, shown right next to the control that triggered it. */
export function Latency({ label = "first sample" }: { label?: string }) {
  const { firstSampleMs } = useStudio();
  return (
    <span className="latency">
      {label} <b>{firstSampleMs === null ? "..." : `${firstSampleMs.toFixed(1)} ms`}</b>
    </span>
  );
}
