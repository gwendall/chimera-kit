/** Shared shapes for every scenario. One measurement is one row of the report. */

export interface Measurement {
  /** Dotted path, e.g. "load.chromium.cold.wasmCompileMs". */
  name: string;
  value: number;
  unit: string;
  /** The threshold this was checked against, if any. Absent for a measurement that is informational. */
  threshold?: number | undefined;
  /** True if value <= threshold (or, for a floor, value >= threshold); undefined when informational. */
  pass?: boolean | undefined;
  note?: string | undefined;
}

export interface ScenarioContext {
  /** Which browsers to drive, already filtered by --browser. */
  browsers: BrowserName[];
  smoke: boolean;
  /** Absolute path to the repo root (the worktree). */
  root: string;
  /** Absolute path to dist/ (already built). */
  dist: string;
  /** Scratch directory for this run, cleaned by the caller, never by a scenario. */
  tmp: string;
  log(line: string): void;
  /**
   * Records a measurement as soon as it's known, in addition to returning it in the scenario's
   * final array. If the scenario later exceeds its budget (see run.ts's runWithBudget), whatever
   * was already reported here is kept in the report instead of being discarded - a step that
   * finished before a later step hung, or ran long, should still show its numbers.
   */
  report(m: Measurement): void;
}

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface Scenario {
  id: string;
  description: string;
  /** Runs under `--smoke` (chromium only, kept well under a minute). */
  smoke: boolean;
  run(ctx: ScenarioContext): Promise<Measurement[]>;
}
