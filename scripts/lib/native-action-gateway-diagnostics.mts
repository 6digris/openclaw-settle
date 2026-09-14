import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_BYTES = 1024 * 1024;
const MAX_SPANS = 64;
type HistoryPhase = "session_entry" | "history_page" | "startup_projection" | "session_info";
type HistorySpan = {
  ordinal: number;
  phase: HistoryPhase;
  // Relative timeline wall-clock times, not the proxy's monotonic request clock.
  startedMs: number | null;
  finishedMs: number | null;
  outcome: "pending" | "end" | "error";
};
type NativeHistoryWindow = {
  startedAtMs: number;
  offset: number | null;
  identity: { dev: number; ino: number } | null;
};
type NativeHistoryDiagnostic = {
  readStatus:
    | "captured"
    | "missing"
    | "read-error"
    | "start-unavailable"
    | "changed-file"
    | "oversize"
    | "short-read";
  // The child buffers timeline writes. Even a complete file read cannot prove non-execution.
  writerMayBeBuffered: true;
  truncated: boolean;
  incompleteLine: boolean;
  malformedLine: boolean;
  orphanedTerminal: boolean;
  spans: HistorySpan[];
};

/** Excludes fixture setup bytes without probing or warming the Gateway. */
export async function captureNativeHistoryWindow(file: string): Promise<NativeHistoryWindow> {
  try {
    const stat = await fs.stat(file);
    return {
      startedAtMs: Date.now(),
      offset: stat.isFile() ? stat.size : null,
      identity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    return {
      startedAtMs: Date.now(),
      offset: isRecord(error) && error.code === "ENOENT" ? 0 : null,
      identity: null,
    };
  }
}

function historyPhase(name: unknown): HistoryPhase | undefined {
  switch (name) {
    case "gateway.chat.history.session_entry":
      return "session_entry";
    case "gateway.chat.history.history_page":
      return "history_page";
    case "gateway.chat.history.startup_projection":
      return "startup_projection";
    case "gateway.chat.history.session_info":
      return "session_info";
    default:
      return undefined;
  }
}

/** Reads only the private failure window; never returns raw IDs, attributes, paths, or errors. */
export async function readNativeHistoryDiagnostic(
  file: string,
  window: NativeHistoryWindow,
  failedAtMs: number,
): Promise<NativeHistoryDiagnostic> {
  const result: NativeHistoryDiagnostic = {
    readStatus: "start-unavailable",
    writerMayBeBuffered: true,
    truncated: false,
    incompleteLine: false,
    malformedLine: false,
    orphanedTerminal: false,
    spans: [],
  };
  if (window.offset === null) {
    return result;
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, "r");
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size < window.offset ||
      (window.identity && (stat.dev !== window.identity.dev || stat.ino !== window.identity.ino))
    ) {
      result.readStatus = "changed-file";
      return result;
    }
    const length = stat.size - window.offset;
    if (length > MAX_BYTES) {
      result.readStatus = "oversize";
      result.truncated = true;
      return result;
    }
    // Check the size before allocation/read/parse, including on a noisy failed Gateway.
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, window.offset);
    if (bytesRead !== length) {
      result.readStatus = "short-read";
      return result;
    }
    result.readStatus = "captured";
    const text = buffer.toString("utf8");
    result.incompleteLine = text.length > 0 && !text.endsWith("\n");
    const lines = text.split("\n");
    // A concurrent/buffered final line is unknown, never a missing terminal event.
    lines.pop();
    const spans = new Map<string, HistorySpan>();
    for (const line of lines) {
      if (!line) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        result.malformedLine = true;
        continue;
      }
      if (!isRecord(event) || event.schemaVersion !== "openclaw.diagnostics.v1") {
        result.malformedLine = true;
        continue;
      }
      const phase = historyPhase(event.name);
      if (
        !phase ||
        (event.type !== "span.start" && event.type !== "span.end" && event.type !== "span.error")
      ) {
        continue;
      }
      const at = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
      if (
        !Number.isFinite(at) ||
        typeof event.spanId !== "string" ||
        !event.spanId ||
        event.spanId.length > 128
      ) {
        result.malformedLine = true;
        continue;
      }
      if (at < window.startedAtMs || at > failedAtMs) {
        continue;
      }
      let span = spans.get(event.spanId);
      if (!span) {
        if (spans.size === MAX_SPANS) {
          result.truncated = true;
          continue;
        }
        span = {
          ordinal: spans.size + 1,
          phase,
          startedMs: null,
          finishedMs: null,
          outcome: "pending",
        };
        spans.set(event.spanId, span);
        result.spans.push(span);
      }
      if (
        span.phase !== phase ||
        span.outcome !== "pending" ||
        (event.type === "span.start" && span.startedMs !== null)
      ) {
        result.malformedLine = true;
        continue;
      }
      if (event.type === "span.start") {
        span.startedMs = at - window.startedAtMs;
      } else {
        result.orphanedTerminal ||= span.startedMs === null;
        span.finishedMs = at - window.startedAtMs;
        span.outcome = event.type === "span.end" ? "end" : "error";
      }
    }
    return result;
  } catch (error) {
    result.readStatus = isRecord(error) && error.code === "ENOENT" ? "missing" : "read-error";
    return result;
  } finally {
    await handle?.close().catch(() => {
      result.readStatus = "read-error";
    });
  }
}
