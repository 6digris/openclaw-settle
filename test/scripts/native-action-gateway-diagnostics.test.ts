import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  captureNativeHistoryWindow,
  readNativeHistoryDiagnostic,
} from "../../scripts/lib/native-action-gateway-diagnostics.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const privateText = "private-fixture-path-token-and-payload";
function event(name: string, type: string, spanId: string, timestamp: number) {
  return (
    JSON.stringify({
      schemaVersion: "openclaw.diagnostics.v1",
      name,
      type,
      spanId,
      timestamp: new Date(timestamp).toISOString(),
      runId: privateText,
      parentSpanId: privateText,
      attributes: { path: privateText, token: privateText, request: privateText },
      errorMessage: privateText,
    }) + "\n"
  );
}

it("projects only history phases in the native window without exposing private fields", async () => {
  const file = path.join(temps.make("native-history-"), "timeline.jsonl");
  await fs.writeFile(file, privateText + "\n");
  const window = await captureNativeHistoryWindow(file);
  const at = window.startedAtMs;
  await fs.appendFile(
    file,
    [
      event("gateway.chat.history.session_entry", "span.start", privateText + "1", at + 1),
      event("gateway.chat.history.session_entry", "span.end", privateText + "1", at + 2),
      event("gateway.chat.history.history_page", "span.start", privateText + "2", at + 3),
      event("gateway.chat.history.startup_projection", "span.start", privateText + "3", at + 4),
      event("gateway.chat.history.startup_projection", "span.error", privateText + "3", at + 5),
      event("gateway.chat.history.session_info", "span.start", privateText + "4", at + 6),
      event("gateway.chat.history.session_info", "span.end", privateText + "4", at + 7),
      event(privateText, "span.start", privateText, at + 8),
      event("gateway.chat.history.history_page", "span.start", "before-window", at - 1),
      event("gateway.chat.history.history_page", "span.end", privateText + "2", at + 11),
    ].join(""),
  );
  const result = await readNativeHistoryDiagnostic(file, window, at + 10);
  expect(result).toEqual({
    readStatus: "captured",
    writerMayBeBuffered: true,
    truncated: false,
    incompleteLine: false,
    malformedLine: false,
    orphanedTerminal: false,
    spans: [
      { ordinal: 1, phase: "session_entry", startedMs: 1, finishedMs: 2, outcome: "end" },
      { ordinal: 2, phase: "history_page", startedMs: 3, finishedMs: null, outcome: "pending" },
      { ordinal: 3, phase: "startup_projection", startedMs: 4, finishedMs: 5, outcome: "error" },
      { ordinal: 4, phase: "session_info", startedMs: 6, finishedMs: 7, outcome: "end" },
    ],
  });
  expect(JSON.stringify(result)).not.toContain(privateText);
  expect(JSON.stringify(result)).not.toContain(file);
});

it("retains incomplete, malformed and unmatched terminal evidence as unknown", async () => {
  const file = path.join(temps.make("native-history-incomplete-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  await fs.writeFile(
    file,
    event("gateway.chat.history.history_page", "span.end", privateText, window.startedAtMs + 1) +
      "invalid json\n" +
      event(
        "gateway.chat.history.session_entry",
        "span.start",
        "partial",
        window.startedAtMs + 2,
      ).trimEnd(),
  );
  const result = await readNativeHistoryDiagnostic(file, window, window.startedAtMs + 3);
  expect(result).toMatchObject({
    readStatus: "captured",
    writerMayBeBuffered: true,
    incompleteLine: true,
    malformedLine: true,
    orphanedTerminal: true,
    spans: [{ ordinal: 1, phase: "history_page", startedMs: null, finishedMs: 1, outcome: "end" }],
  });
  expect(JSON.stringify(result)).not.toContain(privateText);
});

it("caps file bytes before parsing and separately caps retained span owners", async () => {
  const file = path.join(temps.make("native-history-bounded-"), "timeline.jsonl");
  const window = await captureNativeHistoryWindow(file);
  await fs.writeFile(file, Buffer.alloc(1024 * 1024 + 1, "x"));
  expect(await readNativeHistoryDiagnostic(file, window, window.startedAtMs + 1)).toMatchObject({
    readStatus: "oversize",
    truncated: true,
    writerMayBeBuffered: true,
    spans: [],
  });
  await fs.writeFile(
    file,
    Array.from({ length: 65 }, (_, index) =>
      event(
        "gateway.chat.history.history_page",
        "span.start",
        `${privateText}${index}`,
        window.startedAtMs,
      ),
    ).join(""),
  );
  const result = await readNativeHistoryDiagnostic(file, window, window.startedAtMs + 1);
  expect(result.readStatus).toBe("captured");
  expect(result.truncated).toBe(true);
  expect(result.spans).toHaveLength(64);
  expect(result.spans.at(-1)?.ordinal).toBe(64);
  expect(JSON.stringify(result)).not.toContain(privateText);
});

it("distinguishes unavailable and changed files without claiming Gateway non-execution", async () => {
  const dir = temps.make("native-history-files-");
  const file = path.join(dir, "timeline.jsonl");
  const absent = await captureNativeHistoryWindow(file);
  expect(await readNativeHistoryDiagnostic(file, absent, Date.now())).toMatchObject({
    readStatus: "missing",
    writerMayBeBuffered: true,
    spans: [],
  });
  await fs.writeFile(file, "existing fixture setup\n");
  const present = await captureNativeHistoryWindow(file);
  await fs.rename(file, path.join(dir, "old.jsonl"));
  await fs.writeFile(file, "replacement file\n");
  expect(await readNativeHistoryDiagnostic(file, present, Date.now())).toMatchObject({
    readStatus: "changed-file",
    writerMayBeBuffered: true,
    spans: [],
  });
  const unavailable = await captureNativeHistoryWindow(dir);
  expect(await readNativeHistoryDiagnostic(dir, unavailable, Date.now())).toMatchObject({
    readStatus: "start-unavailable",
    writerMayBeBuffered: true,
    spans: [],
  });
});
