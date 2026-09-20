import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readFixtureLog,
  startTuiFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 25_000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["accept", "dismiss"])(
  "does not reopen a task during pending %s after returning to its session",
  async (action) => {
    const tempDir = tempDirs.make("openclaw-tui-task-action-");
    const releasePath = path.join(tempDir, "release");
    const fixture = await startTuiFixture({
      env: { OPENCLAW_TUI_PTY_TASK_RELEASE_PATH: releasePath },
    });
    try {
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("/session pending-source\r");
      await fixture.run.waitForOutput("session agent:main:pending-source");
      await fixture.run.write("task suggestion proof\r");
      await fixture.run.waitForOutput("Suggested follow-up: Remove stale adapter");
      if (action === "accept") {
        await fixture.run.write("\x1b[A\r", { delay: false });
        await fixture.run.waitForOutput("Press Enter again to start this task.");
      }
      await fixture.run.write("\r", { delay: false });
      await fixture.waitForLogEntry((entry) => entry.method === `${action}TaskSuggestion`);

      await fixture.run.write("/session pending-other\r");
      await fixture.run.waitForOutput("session agent:main:pending-other");
      await fixture.run.write("/session pending-source\r");
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes("session agent:main:pending-source")),
        5_000,
      );
      expect(rows.join("\n")).not.toContain("Suggested follow-up:");

      await writeFile(releasePath, "release");
      await fixture.run.waitForOutput(
        action === "accept" ? "session agent:main:task-pty" : "follow-up task dismissed",
      );
      const calls = await readFixtureLog(fixture.logPath);
      expect(calls.filter((entry) => entry.method === `${action}TaskSuggestion`)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);

it.each(["complete", "cancel"])(
  "keeps a draft editable while yielded child activity retracts and reaches %s",
  async (terminal) => {
    const dir = tempDirs.make("openclaw-tui-child-progress-");
    const progressPath = path.join(dir, "progress");
    await writeFile(progressPath, "");
    const fixture = await startTuiFixture({
      env: { OPENCLAW_TUI_PTY_TASK_PROGRESS_PATH: progressPath },
    });
    try {
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("task progress proof\r");
      await fixture.run.waitForOutput("PARENT_YIELDED");
      await fixture.run.waitForOutput("CHILD_STARTED");
      await fixture.run.write("draft remains editable");
      await writeFile(progressPath, "update");
      const running = await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) =>
          rows.some((row) => row.includes("CHILD_PROGRESS_AFTER_YIELD")) &&
          rows.some((row) => row.includes("draft remains editable")),
        5_000,
      );
      expect(running.join("\n")).toContain("Child investigation [running]");
      expect(running.join("\n")).toContain("[ ] Review child result");

      await writeFile(progressPath, "retract");
      await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) =>
          rows.some((row) => row.includes("Child investigation [running]")) &&
          !rows.some((row) => row.includes("Child command")),
        5_000,
      );
      await writeFile(progressPath, "unknown");
      const unknown = await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) => rows.some((row) => row.includes("Child investigation [unknown]")),
        5_000,
      );
      expect(unknown.join("\n")).not.toContain("Child command");

      await writeFile(progressPath, terminal);
      const done = await waitForSynchronizedFrameRows(
        fixture.run,
        (rows) =>
          rows.some((row) =>
            row.includes(terminal === "complete" ? "CHILD_COMPLETED" : "CHILD_CANCELLED"),
          ),
        5_000,
      );
      expect(done.join("\n")).not.toContain("[running]");
      expect(done.join("\n")).toContain("draft remains editable");
      // A child terminal event cannot complete the parent's authored checklist.
      expect(done.join("\n")).toContain("[ ] Review child result");
    } finally {
      await fixture.cleanup();
    }
  },
  TEST_TIMEOUT_MS,
);
