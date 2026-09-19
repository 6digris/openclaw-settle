import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sleep } from "../utils/sleep.js";
import {
  buildTuiLastSessionScopeKey,
  readTuiLastSessionKey,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";
import {
  disposeActiveTuiFixtures,
  objectFieldEquals,
  readFixtureLog,
  startTuiFixture,
  waitForSynchronizedFrameRows,
  type FixtureLogEntry,
} from "./tui-pty-harness-fixture-test-support.js";

const STARTUP_TIMEOUT_MS = 60_000;
const REMEMBERED_SESSION_KEY = "agent:main:picker-target";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function seedRememberedSession(
  stateDir: string,
  sessionKey: string = REMEMBERED_SESSION_KEY,
  sessionScope: "global" | "per-sender" = "per-sender",
) {
  await writeTuiLastSessionKey({
    scopeKey: buildTuiLastSessionScopeKey({
      connectionUrl: "pty-fixture://local",
      agentId: "main",
      sessionScope,
    }),
    sessionKey,
    stateDir,
  });
}

async function waitForLogCount(params: {
  logPath: string;
  predicate: (entry: FixtureLogEntry) => boolean;
  count: number;
}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (; Date.now() < deadline; await sleep(25)) {
    const entries = await readFixtureLog(params.logPath);
    if (entries.filter(params.predicate).length >= params.count) {
      return entries;
    }
  }
  throw new Error(`fixture log did not reach ${params.count} matching entries`);
}

function markerSends(entries: FixtureLogEntry[], marker: string) {
  return entries.filter(
    (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
  );
}

async function waitForSubmitDecision(params: {
  fixture: Awaited<ReturnType<typeof startTuiFixture>>;
  marker: string;
  outputOffset: number;
}) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (; Date.now() < deadline; await sleep(25)) {
    const entries = await readFixtureLog(params.fixture.logPath);
    const output = params.fixture.run.visibleOutput().slice(params.outputOffset);
    if (
      markerSends(entries, params.marker).length > 0 ||
      output.includes("local runtime not ready — message not sent")
    ) {
      return { entries, output };
    }
  }
  throw new Error("TUI neither blocked nor sent the submitted marker");
}

afterEach(async () => {
  await disposeActiveTuiFixtures();
});

it("refreshes the footer only for an accepted fallback destination without reloading history", async () => {
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_TUI_PTY_MODEL: "gpt-4o",
      OPENCLAW_TUI_PTY_COLS: "100",
      OPENCLAW_TUI_PTY_ROWS: "30",
    },
  });
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("fallback footer proof\r", { delay: false });
    const before = await waitForSynchronizedFrameRows(
      fixture.run,
      (rows) => rows.some((row) => row.includes("FALLBACK_RUN_ACTIVE")),
      STARTUP_TIMEOUT_MS,
    );
    const footerRows = (rows: string[]) =>
      rows.filter((row) => row.includes("| session main (Main) |"));
    expect(footerRows(before)).toHaveLength(1);
    const initialFooter = footerRows(before)[0]!;
    expect(initialFooter).toContain("gpt-4o");
    const backendCalls = (entries: FixtureLogEntry[]) =>
      entries.filter((entry) =>
        ["loadHistory", "describeSession", "listSessions", "patchSession", "sendChat"].includes(
          entry.method,
        ),
      );
    const initialCalls = backendCalls(await readFixtureLog(fixture.logPath));
    expect(initialCalls.filter((entry) => entry.method === "sendChat")).toHaveLength(1);
    expect(initialCalls.filter((entry) => entry.method === "patchSession")).toHaveLength(0);

    for (const step of [1, 2, 3]) {
      await fixture.run.write("/gateway-status\r", { delay: false });
      const rows = await waitForSynchronizedFrameRows(
        fixture.run,
        (frame) => frame.some((row) => row.includes(`FALLBACK_EVENT_DELIVERED_${step}`)),
        STARTUP_TIMEOUT_MS,
      );
      const entries = await readFixtureLog(fixture.logPath);
      const calls = backendCalls(entries);
      expect(calls).toEqual(initialCalls);
      expect(entries.findLast((entry) => entry.method === "fallbackSelection")?.payload).toEqual({
        step,
        model: "gpt-4o",
      });
      expect(footerRows(rows)).toHaveLength(1);
      console.info(
        "TUI_FALLBACK_FRAME",
        JSON.stringify({
          step,
          cols: fixture.run.cols,
          rows: fixture.run.rows,
          before,
          frame: rows,
          event: entries.findLast((entry) => entry.method === "fallbackEvent"),
          selection: entries.findLast((entry) => entry.method === "fallbackSelection"),
          initialCalls,
          calls,
        }),
      );
      if (step < 3) {
        expect(footerRows(rows)[0]).toBe(initialFooter);
      } else {
        expect
          .soft(footerRows(rows)[0], "TUI_FALLBACK_FOOTER_DESTINATION")
          .toBe(initialFooter.replace("gpt-4o", "claude-sonnet-4"));
      }
    }
  } finally {
    try {
      await fixture.run.write("/exit\r", { delay: false });
      const exit = await fixture.run.waitForExit();
      console.info("TUI_FALLBACK_EXIT", JSON.stringify(exit));
      expect(exit.exitCode).toBe(0);
      expect(exit.signal ?? 0).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }
}, 65_000);
it("submits provider-specific thinking labels with one Enter", async () => {
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_TUI_PTY_THINKING_LABEL: "on",
      OPENCLAW_TUI_PTY_SAFE_THINKING_LABEL: "always on",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);

    for (const [index, { label, id }] of [
      { label: "on", id: "fixture-thinking" },
      { label: "always on", id: "fixture-thinking-safe" },
    ].entries()) {
      await fixture.run.write(`/think ${label}`, { delay: false });
      await fixture.run.waitForOutput(`→ ${label}`, STARTUP_TIMEOUT_MS);
      await fixture.run.write("\r", { delay: false });
      const entries = await waitForLogCount({
        logPath: fixture.logPath,
        predicate: (entry) => entry.method === "patchSession",
        count: index + 1,
      });
      expect(entries.findLast((entry) => entry.method === "patchSession")?.payload).toMatchObject({
        thinkingLevel: id,
      });
      await fixture.run.waitForOutput(`thinking set to ${label}`, STARTUP_TIMEOUT_MS);
    }
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("clears the previous display name when the selected session is unnamed", async () => {
  const fixture = await startTuiFixture();
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("/session agent:main:mode-source\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:mode-source"),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.run.waitForOutput("Production incident", STARTUP_TIMEOUT_MS);

    const targetOutputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write("/session agent:main:mode-target\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:mode-target"),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.run.waitForOutput("session mode-target", STARTUP_TIMEOUT_MS);

    expect(fixture.run.visibleOutput().slice(targetOutputOffset)).not.toContain(
      "Production incident",
    );
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps the active stream when the current session is selected again", async () => {
  const fixture = await startTuiFixture({
    env: { OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1", OPENCLAW_TUI_PTY_SESSION: "agent:main:main" },
  });
  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("streaming prompt\r", { delay: false });
    await fixture.run.waitForOutput("PTY_STREAMING: streaming prompt", STARTUP_TIMEOUT_MS);
    const historyLoadsBefore = (await readFixtureLog(fixture.logPath)).filter(
      (entry) => entry.method === "loadHistory",
    ).length;

    await fixture.run.write("/sessions\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) => entry.method === "listSessions" && objectFieldEquals(entry, "purpose", "picker"),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.run.write("\r", { delay: false });
    await fixture.run.write("/think high\r/think\r", { delay: false });
    const patch = await fixture.waitForLogEntry(
      (entry) => entry.method === "patchSession",
      STARTUP_TIMEOUT_MS,
    );
    expect(patch.payload).toMatchObject({ key: "agent:main:main", thinkingLevel: "high" });
    expect(patch.payload).not.toHaveProperty("targetIntent");
    await fixture.run.waitForOutput("usage: /think", STARTUP_TIMEOUT_MS);
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("PTY_STREAMING: streaming prompt")),
      STARTUP_TIMEOUT_MS,
    );

    expect(rows.join("\n")).not.toContain("local ready | idle");
    expect(
      (await readFixtureLog(fixture.logPath)).filter((entry) => entry.method === "loadHistory"),
    ).toHaveLength(historyLoadsBefore);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("hides a stale approval when startup restores the remembered session", async () => {
  const stateDir = tempDirs.make("openclaw-tui-identity-");
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_INITIAL_APPROVAL_SESSION_KEY: "agent:main:main",
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      STARTUP_TIMEOUT_MS,
    );
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "listPluginApprovals" && objectFieldEquals(entry, "pending", true),
      STARTUP_TIMEOUT_MS,
    );
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("session picker-target")),
      STARTUP_TIMEOUT_MS,
    );

    expect(rows.join("\n")).not.toContain("workspace skill approval");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it.each([
  {
    sessionScope: "per-sender",
    selector: "agent:main:main",
    expectedKey: "agent:main:main",
    intent: "exact",
  },
  {
    sessionScope: "global",
    selector: "agent:main:global",
    expectedKey: "agent:main:global",
    intent: "exact",
  },
  { sessionScope: "per-sender", selector: "main", expectedKey: "agent:main:main", intent: "home" },
  { sessionScope: "global", selector: "main", expectedKey: "agent:main:global", intent: "home" },
])(
  "remembers $intent intent across SQLite-backed TUI restart for $selector ($sessionScope)",
  async ({ sessionScope, selector, expectedKey, intent }) => {
    const stateDir = tempDirs.make("openclaw-tui-intent-restart-");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_SESSION_SCOPE: sessionScope,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: expectedKey,
    };
    for (const launch of ["selected", "restored"]) {
      const marker = `remembered intent ${launch} proof`;
      const fixture = await startTuiFixture({
        env: { ...env, ...(launch === "selected" ? { OPENCLAW_TUI_PTY_SESSION: selector } : {}) },
      });
      try {
        await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
        await fixture.run.write(`${marker}\r`, { delay: false });
        const sent = await fixture.waitForLogEntry(
          (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
          STARTUP_TIMEOUT_MS,
        );
        expect(sent.payload).toMatchObject({ sessionKey: expectedKey });
        if (intent === "home") {
          expect(sent.payload).toHaveProperty("targetIntent", "home");
        } else {
          expect(sent.payload).not.toHaveProperty("targetIntent");
        }
      } finally {
        await fixture.cleanup();
      }
      if (launch === "selected") {
        await expect(
          readTuiLastSessionKey({
            scopeKey: buildTuiLastSessionScopeKey({
              connectionUrl: "pty-fixture://local",
              agentId: "main",
              sessionScope: sessionScope === "global" ? "global" : "per-sender",
            }),
            stateDir,
          }),
        ).resolves.toBe(
          intent === "home" ? (sessionScope === "global" ? "global" : "main") : expectedKey,
        );
      }
    }
  },
  65_000,
);

it.each([
  { scope: "global", mainKey: "main", stored: "main", key: "agent:main:main", intent: "exact" },
  {
    scope: "global",
    mainKey: "primary",
    stored: "main",
    key: "agent:main:primary",
    intent: "exact",
  },
  {
    scope: "per-sender",
    mainKey: "main",
    stored: "agent:main:main",
    key: "agent:main:main",
    intent: "exact",
  },
  {
    scope: "per-sender",
    mainKey: "primary",
    stored: "agent:main:main",
    key: "agent:main:main",
    intent: "exact",
  },
  {
    scope: "per-sender",
    mainKey: "secondary",
    stored: "agent:main:primary",
    key: "agent:main:primary",
    intent: "exact",
  },
  { scope: "global", mainKey: "main", stored: "global", key: "agent:main:global", intent: "home" },
  {
    scope: "per-sender",
    mainKey: "main",
    stored: "global",
    key: "agent:main:global",
    intent: "exact",
  },
  {
    scope: "per-sender",
    mainKey: "primary",
    stored: "main",
    key: "agent:main:primary",
    intent: "home",
  },
])(
  "restores published string $stored under $scope/$mainKey as $intent",
  async ({ scope, mainKey, stored, key, intent }) => {
    const stateDir = tempDirs.make("openclaw-tui-published-restore-");
    await seedRememberedSession(stateDir, stored, scope === "global" ? "global" : "per-sender");
    const fixture = await startTuiFixture({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TUI_PTY_SESSION_SCOPE: scope,
        OPENCLAW_TUI_PTY_MAIN_KEY: mainKey,
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: key,
      },
    });
    try {
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      await fixture.run.write("published restore proof\r", { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) =>
          entry.method === "sendChat" &&
          objectFieldEquals(entry, "message", "published restore proof"),
        STARTUP_TIMEOUT_MS,
      );
      expect(sent.payload).toMatchObject({ sessionKey: key });
      if (intent === "home") {
        expect(sent.payload).toHaveProperty("targetIntent", "home");
      } else {
        expect(sent.payload).not.toHaveProperty("targetIntent");
      }
    } finally {
      await fixture.cleanup();
    }
  },
  65_000,
);

it("restores a remembered global session while keeping pre-ready input editable", async () => {
  const stateDir = tempDirs.make("openclaw-tui-startup-session-");
  const marker = "startup remembered session proof";
  await seedRememberedSession(stateDir, "global");
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: "global",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "400",
    },
  });

  try {
    const lookup = await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "describeSession" &&
        objectFieldEquals(entry, "sessionKey", "agent:main:global"),
      STARTUP_TIMEOUT_MS,
    );
    expect(lookup.payload).toEqual({ sessionKey: "agent:main:global" });
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session global")) &&
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain(marker);
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: "agent:main:global" });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps input editable while remembered startup history is loading", async () => {
  const stateDir = tempDirs.make("openclaw-tui-startup-history-");
  const marker = "startup remembered history proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_STARTUP_DELAY_MS: "400",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) =>
        entry.method === "loadHistory" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      STARTUP_TIMEOUT_MS,
    );
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps reconnect input editable until restored history is stable", async () => {
  const stateDir = tempDirs.make("openclaw-tui-reconnect-session-");
  const marker = "reconnect remembered session proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
      OPENCLAW_TUI_PTY_RECONNECT_HISTORY_DELAY_MS: "400",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write("/gateway-status\r", { delay: false });
    await fixture.waitForLogEntry(
      (entry) => entry.method === "reconnectHistoryPending",
      STARTUP_TIMEOUT_MS,
    );
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("gateway reconnected after transport loss")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain(marker);
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("keeps an explicit launch session authoritative over remembered state", async () => {
  const stateDir = tempDirs.make("openclaw-tui-explicit-session-");
  const explicitSession = "agent:main:main";
  const marker = "explicit startup session proof";
  await seedRememberedSession(stateDir, REMEMBERED_SESSION_KEY, "global");
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_SESSION: explicitSession,
      OPENCLAW_TUI_PTY_SESSION_SCOPE: "global",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    await fixture.run.write(`${marker}\r`, { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: explicitSession });
    await fixture.run.waitForOutput("session main", STARTUP_TIMEOUT_MS);
    const entries = await readFixtureLog(fixture.logPath);
    expect(
      entries.some(
        (entry) =>
          entry.method === "describeSession" &&
          objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      ),
    ).toBe(false);
    expect(markerSends(entries, marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("falls back after a remembered lookup error and retries on reconnect", async () => {
  const stateDir = tempDirs.make("openclaw-tui-restore-failure-");
  const marker = "restore failure fallback proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_FAILURES: "1",
      OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture restore lookup retry",
    },
  });

  try {
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);

    // After fallback the header/footer must agree with the send target, not
    // retain the stale provisional label.
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session picker-target");

    await fixture.run.write(`${marker}\r`, { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: "agent:main:main" });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
    await fixture.run.waitForOutput(`PTY_RESPONSE: ${marker}`, STARTUP_TIMEOUT_MS);

    // Another TUI can replace the scoped pointer after fallback. A transient
    // validation error must leave the next connection eligible to restore it.
    await seedRememberedSession(stateDir);
    await fixture.run.write("/gateway-status\r", { delay: false });
    await fixture.waitForLogEntry((entry) => entry.method === "disconnect", STARTUP_TIMEOUT_MS);
    await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes("session picker-target")),
      STARTUP_TIMEOUT_MS,
    );
    const retryMarker = "restore lookup retry proof";
    await fixture.run.write(`${retryMarker}\r`, { delay: false });
    const retried = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", retryMarker),
      STARTUP_TIMEOUT_MS,
    );
    expect(retried.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), retryMarker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("shows the remembered session label during startup before remote validation", async () => {
  const stateDir = tempDirs.make("openclaw-tui-provisional-label-");
  await seedRememberedSession(stateDir);
  // 10000 ms restore delay ensures describeSession is still pending when the
  // first synchronized frame renders.  The predicate timeout of 8000 ms
  // matches only frames rendered before validation completes — the pre-fix
  // code renders "session main" first and would time out.
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "10000",
    },
  });

  try {
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        !frame.some((row) => row.includes("session main")),
      8_000,
    );
    expect(rows.join("\n")).toContain("session picker-target");

    // After validation completes the confirmed session label persists.
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    const readyRows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );
    expect(readyRows.join("\n")).toContain("session picker-target");
    expect(readyRows.join("\n")).not.toContain("session main");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("clears the provisional label after a failed remembered-session lookup", async () => {
  const stateDir = tempDirs.make("openclaw-tui-provisional-failure-");
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "10000",
      OPENCLAW_TUI_PTY_RESTORE_FAILURES: "1",
    },
  });

  try {
    // While validation is pending the header shows the remembered name.
    const earlyRows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        !frame.some((row) => row.includes("session main")),
      8_000,
    );
    expect(earlyRows.join("\n")).toContain("session picker-target");

    // After the delayed lookup fails the label must reconcile to the default.
    await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
    const readyRows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) => frame.some((row) => row.includes("local ready")),
      STARTUP_TIMEOUT_MS,
    );
    expect(readyRows.join("\n")).toContain("session main");
    expect(readyRows.join("\n")).not.toContain("session picker-target");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("abandons a stale restore generation without sending or duplicating input", async () => {
  const stateDir = tempDirs.make("openclaw-tui-restore-generation-");
  const marker = "restore generation proof";
  await seedRememberedSession(stateDir);
  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RECONNECT_DURING_RESTORE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "400",
    },
  });

  try {
    await fixture.waitForLogEntry(
      (entry) => entry.method === "restoreReconnect",
      STARTUP_TIMEOUT_MS,
    );
    await waitForLogCount({
      logPath: fixture.logPath,
      predicate: (entry) =>
        entry.method === "describeSession" &&
        objectFieldEquals(entry, "sessionKey", REMEMBERED_SESSION_KEY),
      count: 2,
    });
    const outputOffset = fixture.run.visibleOutput().length;
    await fixture.run.write(`${marker}\r`, { delay: false });
    const decision = await waitForSubmitDecision({ fixture, marker, outputOffset });
    expect(markerSends(decision.entries, marker).map((entry) => entry.payload)).toEqual([]);
    expect(decision.output).toContain("local runtime not ready — message not sent");
    await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session picker-target")) &&
        frame.some((row) => row.includes("local ready")) &&
        frame.some((row) => row.includes(marker)),
      STARTUP_TIMEOUT_MS,
    );
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(0);

    await fixture.run.write("\r", { delay: false });
    const sent = await fixture.waitForLogEntry(
      (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
      STARTUP_TIMEOUT_MS,
    );
    expect(sent.payload).toMatchObject({ sessionKey: REMEMBERED_SESSION_KEY });
    expect(markerSends(await readFixtureLog(fixture.logPath), marker)).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it("starts normally when the pre-render state read throws", async () => {
  // A state database using a newer schema version makes readTuiLastSessionKey
  // throw during the pre-render lookup. The TUI must still start (reach its
  // established startup-failure path inside the started UI) rather than
  // rejecting runTui() before tui.start().
  const stateDir = tempDirs.make("openclaw-tui-future-state-");
  await seedRememberedSession(stateDir);
  // Overwrite the seeded DB with a valid but future-version database so the
  // read-only open throws a schema-version error before any query runs.
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)",
  );
  const scopeKey = buildTuiLastSessionScopeKey({
    connectionUrl: "pty-fixture://local",
    agentId: "main",
    sessionScope: "per-sender",
  });
  db.prepare(
    "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
  ).run(`tui.lastSession.${scopeKey}`, JSON.stringify(REMEMBERED_SESSION_KEY), Date.now());
  db.exec("PRAGMA user_version = 999");
  db.close();

  const fixture = await startTuiFixture({
    env: {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
      OPENCLAW_TUI_PTY_RESTORE_DELAY_MS: "10000",
    },
  });

  try {
    // The TUI must reach a rendered frame — it must not reject runTui() before
    // tui.start(). The schema-version error also breaks the post-connect
    // restore, so the status shows "startup failed"; what matters is that the
    // UI is active and the header uses the default session, not the remembered
    // label that the failed read could not produce.
    const rows = await waitForSynchronizedFrameRows(
      fixture.run,
      (frame) =>
        frame.some((row) => row.includes("session main")) &&
        !frame.some((row) => row.includes("session picker-target")),
      STARTUP_TIMEOUT_MS,
    );
    expect(rows.join("\n")).toContain("session main");
    expect(rows.join("\n")).not.toContain("session picker-target");
  } finally {
    await fixture.cleanup();
  }
}, 65_000);

it.each([
  {
    name: "default Home",
    session: "",
    scope: "per-sender",
    remembered: "",
    key: "agent:main:main",
    home: true,
  },
  {
    name: "bare main Home",
    session: "main",
    scope: "per-sender",
    remembered: "",
    key: "agent:main:main",
    home: true,
  },
  {
    name: "published canonical remembered conversation",
    session: "",
    scope: "per-sender",
    remembered: "agent:main:main",
    key: "agent:main:main",
    home: false,
  },
  {
    name: "published raw global Home",
    session: "",
    scope: "global",
    remembered: "global",
    key: "agent:main:global",
    home: true,
  },
  {
    name: "remembered literal main in global scope",
    session: "",
    scope: "global",
    remembered: "agent:main:main",
    key: "agent:main:main",
    home: false,
  },
  {
    name: "remembered literal unknown in per-sender scope",
    session: "",
    scope: "per-sender",
    remembered: "agent:main:unknown",
    key: "agent:main:unknown",
    home: false,
  },
  {
    name: "remembered literal unknown in global scope",
    session: "",
    scope: "global",
    remembered: "agent:main:unknown",
    key: "agent:main:unknown",
    home: false,
  },
  {
    name: "explicit literal main",
    session: "agent:main:main",
    scope: "per-sender",
    remembered: "",
    key: "agent:main:main",
    home: false,
  },
] as const)(
  "keeps selector intent for $name through real TUI startup and reconnect",
  async ({ session, scope, remembered, key, home }) => {
    const stateDir = tempDirs.make("openclaw-tui-selector-intent-");
    if (remembered) {
      await seedRememberedSession(stateDir, remembered, scope);
    }
    const fixture = await startTuiFixture({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_TUI_PTY_SESSION: session,
        OPENCLAW_TUI_PTY_SESSION_SCOPE: scope,
        OPENCLAW_TUI_PTY_PICKER_FIXTURE: "1",
        OPENCLAW_TUI_PTY_DISCONNECT_REASON: "fixture transport loss",
        OPENCLAW_TUI_PTY_PICKER_SESSION_KEY: key,
      },
    });
    try {
      await fixture.run.waitForOutput("local ready", STARTUP_TIMEOUT_MS);
      if (remembered && key !== (scope === "global" ? "agent:main:global" : "agent:main:main")) {
        const lookup = await fixture.waitForLogEntry(
          (entry) =>
            entry.method === "describeSession" && objectFieldEquals(entry, "sessionKey", key),
          STARTUP_TIMEOUT_MS,
        );
        expect(lookup.payload).toEqual({ sessionKey: key });
      }
      await fixture.run.write("/gateway-status\r", { delay: false });
      await fixture.run.waitForOutput(
        "gateway reconnected after transport loss",
        STARTUP_TIMEOUT_MS,
      );
      const marker = "selector intent startup proof";
      await fixture.run.write(`${marker}\r`, { delay: false });
      const sent = await fixture.waitForLogEntry(
        (entry) => entry.method === "sendChat" && objectFieldEquals(entry, "message", marker),
        STARTUP_TIMEOUT_MS,
      );
      expect(sent.payload).toMatchObject({ sessionKey: key });
      if (home) {
        expect(sent.payload).toMatchObject({ targetIntent: "home" });
      } else {
        expect(sent.payload).not.toHaveProperty("targetIntent");
      }
    } finally {
      await fixture.cleanup();
    }
  },
  65_000,
);
