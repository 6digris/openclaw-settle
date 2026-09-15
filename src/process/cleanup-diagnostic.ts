import { appendFileSync } from "node:fs";

// Disposable PR diagnostic: only the original overflow test sets this marker.
// Capture it once so late owner completion remains observable after test cleanup.
export function createCleanupDiagnostic(component: string) {
  const target = process.env.OPENCLAW_CUA_CLEANUP_TRACE;
  let sequence = 0;
  let failed = false;
  return (event: string, facts: Record<string, boolean | number | null> = {}) => {
    if (!target || failed) {
      return;
    }
    if (sequence >= 128) {
      failed = true;
      return;
    }
    try {
      appendFileSync(
        target,
        `${JSON.stringify({
          component,
          sequence: ++sequence,
          event: sequence === 128 ? "trace-cap-reached" : event,
          monotonicMs: Number(process.hrtime.bigint()) / 1e6,
          wallMs: Date.now(),
          ...facts,
        })}\n`,
        { mode: 0o600 },
      );
    } catch {
      failed = true;
      // Missing terminal records make this diagnostic incomplete; never replace
      // the original test outcome or use protocol/output pipes for diagnostics.
    }
  };
}
