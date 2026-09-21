import { expect } from "vitest";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";

export const readAttemptTerminal = (result: EmbeddedRunAttemptResult) =>
  attemptTerminal.project(result.terminal);

export const projectAttemptResult = (result: EmbeddedRunAttemptResult) => ({
  ...result,
  ...readAttemptTerminal(result),
});

export function expectSuccessfulAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result).aborted).toBe(false);
  expect(readAttemptTerminal(result).timedOut).toBe(false);
  expect(readAttemptTerminal(result).promptError).toBeNull();
}

export function expectTimedOutAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result).aborted).toBe(true);
  expect(readAttemptTerminal(result).timedOut).toBe(true);
  expect(readAttemptTerminal(result).promptError).toBe(
    "codex app-server execution budget timed out",
  );
}
