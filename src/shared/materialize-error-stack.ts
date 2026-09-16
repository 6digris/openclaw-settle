/** Retained diagnostics must not retain the caller through V8's lazy stack frames. */
export function materializeErrorStack(failure: unknown): void {
  let error = failure;
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    try {
      error.stack = String(error.stack);
    } catch {
      // V8's setter releases private frames even when formatting throws;
      // coercion also detaches CallSites returned by a custom formatter.
      error.stack = "Stack trace unavailable: custom formatter failed";
    }
    // Nested causes retain their original identity while releasing their caller frames.
    error = error.cause;
  }
}
