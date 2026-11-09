import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Calibration } from "./sys.ts";
import type { Measurement } from "./types.ts";

export interface ScenarioReport {
  id: string;
  description: string;
  ok: boolean;
  skipped?: string | undefined;
  error?: string | undefined;
  measurements: Measurement[];
  durationMs: number;
}

export interface RunReport {
  startedAt: string;
  calibration: Calibration;
  browsers: string[];
  smoke: boolean;
  scenarios: ScenarioReport[];
  totalDurationMs: number;
  ok: boolean;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmtValue(m: Measurement): string {
  const v = Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(2);
  return `${v} ${m.unit}`;
}

/** The compact table printed to stdout. */
export function printTable(report: RunReport): void {
  console.log(
    `\n${report.calibration.uptimeLine}  (busy-work yardstick: ${report.calibration.busyWorkMs.toFixed(0)} ms)\n`,
  );
  for (const s of report.scenarios) {
    const status = s.skipped ? "SKIP" : s.ok ? "ok  " : "FAIL";
    console.log(
      `${status} ${pad(s.id, 24)} ${(s.durationMs / 1000).toFixed(1)}s${s.skipped ? `  (${s.skipped})` : ""}`,
    );
    if (s.error) console.log(`     error: ${s.error}`);
    for (const m of s.measurements) {
      const mark = m.pass === undefined ? "  " : m.pass ? "ok" : "!!";
      const against = m.threshold === undefined ? "" : ` (threshold ${m.threshold} ${m.unit})`;
      console.log(
        `     ${mark} ${pad(m.name, 48)} ${fmtValue(m)}${against}${m.note ? `  -- ${m.note}` : ""}`,
      );
    }
  }
  const failed = report.scenarios.filter((s) => !s.ok && !s.skipped);
  console.log(
    `\n${report.ok ? "PASS" : "FAIL"}: ${report.scenarios.length} scenarios, ${failed.length} failed, ${(report.totalDurationMs / 1000).toFixed(1)}s total\n`,
  );
}

export async function writeJson(path: string, report: RunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2));
}

export async function writeMarkdown(path: string, report: RunReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines: string[] = [];
  lines.push("# intone e2e report");
  lines.push("");
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Browsers: ${report.browsers.join(", ")}${report.smoke ? " (smoke)" : ""}`);
  lines.push(`Machine: ${report.calibration.uptimeLine}`);
  lines.push(`CPU yardstick (fixed busy-work loop): ${report.calibration.busyWorkMs.toFixed(0)} ms`);
  lines.push("");
  lines.push(
    `Overall: **${report.ok ? "PASS" : "FAIL"}** in ${(report.totalDurationMs / 1000).toFixed(1)} s`,
  );
  lines.push("");
  for (const s of report.scenarios) {
    lines.push(`## ${s.id}`);
    lines.push("");
    lines.push(s.description);
    lines.push("");
    if (s.skipped) {
      lines.push(`Skipped: ${s.skipped}`);
      lines.push("");
      continue;
    }
    lines.push(`Status: **${s.ok ? "pass" : "fail"}** (${(s.durationMs / 1000).toFixed(1)} s)`);
    if (s.error) lines.push(`\nError: \`${s.error}\``);
    lines.push("");
    if (s.measurements.length > 0) {
      lines.push("| measurement | value | threshold | pass | note |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const m of s.measurements) {
        lines.push(
          `| ${m.name} | ${fmtValue(m)} | ${m.threshold ?? "-"} | ${m.pass === undefined ? "-" : m.pass ? "yes" : "no"} | ${m.note ?? ""} |`,
        );
      }
      lines.push("");
    }
  }
  await writeFile(path, lines.join("\n"));
}
