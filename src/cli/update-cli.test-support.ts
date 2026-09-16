import type fs from "node:fs";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import type { UpdateCommandOptions } from "./update-cli/shared.js";

export function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

export function buildUpdateCliArgs(opts: UpdateCommandOptions): string[] {
  const args = ["update"];
  for (const key of ["yes", "json", "dryRun", "acceptCapabilities"] as const) {
    if (opts[key]) {
      args.push(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`);
    }
  }
  if (opts.restart === false) {
    args.push("--no-restart");
  }
  for (const key of ["channel", "tag", "timeout"] as const) {
    if (opts[key] !== undefined) {
      args.push(`--${key}`, opts[key]);
    }
  }
  return args;
}

export const statfsFixture = (params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fs.statfsSync> => ({
  type: 0,
  bsize: params.bsize ?? 1024,
  blocks: params.blocks ?? 2_000_000,
  bfree: params.bavail,
  bavail: params.bavail,
  files: 0,
  frsize: params.bsize ?? 1024,
  ffree: 0,
});

export const makeOkUpdateResult = (overrides: Partial<UpdateRunResult> = {}): UpdateRunResult => ({
  status: "ok",
  mode: "git",
  steps: [],
  durationMs: 100,
  after: { version: "1.0.0" },
  ...overrides,
});

export function reportCandidateSteps<T extends { steps: UpdateRunResult["steps"] }>(
  options: { onStep?: (step: UpdateRunResult["steps"][number]) => void },
  result: T,
): T {
  for (const step of result.steps) {
    options.onStep?.(step);
  }
  return result;
}
