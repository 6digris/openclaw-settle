// Verifies last-session persistence and lookup for TUI launch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as configMachineState from "../state/config-machine-state-write.js";
import { readConfigMachineStateWithMetadata } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildTuiLastSessionScopeKey,
  clearTuiLastSessionPointers,
  createRememberSessionKeyWriter,
  readTuiLastSessionKey,
  resolveRememberedTuiSessionKey,
  writeTuiLastSessionKey,
} from "./tui-last-session.js";

const tempDirs: string[] = [];

async function makeTempStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tui-last-session-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("tui last session state", () => {
  it("returns no remembered session without creating state on a fresh install", async () => {
    const stateDir = await makeTempStateDir();

    await expect(readTuiLastSessionKey({ scopeKey: "missing", stateDir })).resolves.toBeNull();
    await expect(fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    { agentId: "Main", sessionKey: "agent:main:tui-123", writer: "direct" },
    { agentId: "Work", sessionKey: "agent:work:unknown", writer: "direct" },
    { agentId: "Work", sessionKey: "agent:work:unknown", writer: "remember" },
  ])(
    "persists and restores $sessionKey through the $writer writer",
    async ({ agentId, sessionKey, writer }) => {
      const stateDir = await makeTempStateDir();
      const scopeKey = buildTuiLastSessionScopeKey({
        connectionUrl: "ws://127.0.0.1:18789",
        agentId,
        sessionScope: "per-sender",
      });
      const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
      configMachineState.writeConfigMachineState(
        `tui.lastSession.${scopeKey}`,
        `agent:${agentId.toLowerCase()}:previous`,
        options,
      );
      const failures: string[] = [];
      const write = (key: string) =>
        writeTuiLastSessionKey({ scopeKey, sessionKey: key, stateDir });
      const remember = createRememberSessionKeyWriter({
        buildScopeKey: () => scopeKey,
        reportFailure: (message) => failures.push(message),
        write: (params) => writeTuiLastSessionKey({ ...params, stateDir }),
      });

      for (const key of [sessionKey, " unknown ", "  "]) {
        if (writer === "direct") {
          await write(key);
        } else {
          remember({ sessionKey: key }, "per-sender");
        }
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(failures).toEqual([]);
      await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBe(sessionKey);
      expect(
        readConfigMachineStateWithMetadata<string>(`tui.lastSession.${scopeKey}`, options),
      ).toEqual({ value: sessionKey, updatedAtMs: expect.any(Number) });
      await expect(fs.stat(path.join(stateDir, "tui", "last-session.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      closeOpenClawStateDatabaseForTest();
      const rememberedKey = await readTuiLastSessionKey({ scopeKey, stateDir });
      expect(rememberedKey).toBe(sessionKey);
      expect(
        resolveRememberedTuiSessionKey({
          rememberedKey,
          currentAgentId: agentId,
          sessions: [{ key: "agent:other:unknown" }, { key: sessionKey }],
        }),
      ).toBe(sessionKey);
    },
  );

  it("atomically preserves concurrent updates to independent scopes", async () => {
    const stateDir = await makeTempStateDir();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeTuiLastSessionKey({
          scopeKey: index % 2 === 0 ? "terminal" : "remote",
          sessionKey: `agent:main:tui-${index}`,
          stateDir,
        }),
      ),
    );

    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
      "agent:main:tui-38",
    );
    await expect(readTuiLastSessionKey({ scopeKey: "remote", stateDir })).resolves.toBe(
      "agent:main:tui-39",
    );
  });

  it("restores only a remembered session that still belongs to the current agent", () => {
    const sessions = [
      { key: "agent:main:main" },
      { key: "agent:ops:tui-123" },
      { key: "agent:main:tui-123" },
      { key: "agent:ops:tui-999" },
    ];

    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:tui-123",
        currentAgentId: "main",
        sessions,
      }),
    ).toBe("agent:main:tui-123");
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:ops:tui-999",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:missing",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
  });

  it("does not persist or restore heartbeat sessions", async () => {
    const stateDir = await makeTempStateDir();
    const scopeKey = buildTuiLastSessionScopeKey({
      connectionUrl: "ws://127.0.0.1:18789",
      agentId: "main",
      sessionScope: "per-sender",
    });

    await writeTuiLastSessionKey({
      scopeKey,
      sessionKey: "agent:main:telegram:direct:123:heartbeat",
      stateDir,
    });

    await expect(readTuiLastSessionKey({ scopeKey, stateDir })).resolves.toBeNull();
    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:telegram:direct:123:heartbeat",
        currentAgentId: "main",
        sessions: [{ key: "agent:main:telegram:direct:123:heartbeat" }],
      }),
    ).toBeNull();
  });

  it("does not restore heartbeat-origin sessions when resolving a remembered key", () => {
    const sessions = [
      {
        key: "agent:main:main",
        origin: { provider: "heartbeat", surface: "heartbeat" },
      },
      { key: "agent:main:tui-123" },
    ];

    expect(
      resolveRememberedTuiSessionKey({
        rememberedKey: "agent:main:main",
        currentAgentId: "main",
        sessions,
      }),
    ).toBeNull();
  });

  it("clears only pointers owned by a retired session", async () => {
    const stateDir = await makeTempStateDir();
    await writeTuiLastSessionKey({
      scopeKey: "terminal",
      sessionKey: "agent:main:main",
      stateDir,
    });
    await writeTuiLastSessionKey({
      scopeKey: "remote",
      sessionKey: "agent:main:telegram:thread",
      stateDir,
    });
    await writeTuiLastSessionKey({
      scopeKey: "other-terminal",
      sessionKey: "agent:main:main",
      stateDir,
    });
    configMachineState.writeConfigMachineState("unrelated.sessionReference", "agent:main:main", {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });

    expect(
      clearTuiLastSessionPointers({
        stateDir,
        sessionKeys: new Set(["agent:main:main"]),
      }),
    ).toBe(2);
    await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBeNull();
    await expect(
      readTuiLastSessionKey({ scopeKey: "other-terminal", stateDir }),
    ).resolves.toBeNull();
    await expect(readTuiLastSessionKey({ scopeKey: "remote", stateDir })).resolves.toBe(
      "agent:main:telegram:thread",
    );
    expect(
      readConfigMachineStateWithMetadata<string>("unrelated.sessionReference", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      })?.value,
    ).toBe("agent:main:main");
  });

  it("keeps a live replacement pointer written after the retired-pointer scan", async () => {
    const stateDir = await makeTempStateDir();
    await writeTuiLastSessionKey({
      scopeKey: "terminal",
      sessionKey: "agent:main:retired",
      stateDir,
    });
    const updateMachineState = configMachineState.updateConfigMachineState;
    const replaceBeforeUpdate = vi
      .spyOn(configMachineState, "updateConfigMachineState")
      .mockImplementationOnce((stateKey, update, options) => {
        expect(stateKey).toBe("tui.lastSession.terminal");
        // The real scan selected the retired key. Commit its replacement before
        // delegating to the real transaction that must recheck the current value.
        configMachineState.writeConfigMachineState(stateKey, "agent:main:live", options);
        return updateMachineState(stateKey, update, options);
      });

    try {
      expect(
        clearTuiLastSessionPointers({
          stateDir,
          sessionKeys: new Set(["agent:main:retired"]),
        }),
      ).toBe(0);
      expect(replaceBeforeUpdate).toHaveBeenCalledOnce();
      await expect(readTuiLastSessionKey({ scopeKey: "terminal", stateDir })).resolves.toBe(
        "agent:main:live",
      );
    } finally {
      replaceBeforeUpdate.mockRestore();
    }
  });
});

describe("createRememberSessionKeyWriter", () => {
  it.each([
    { key: "agent:main:primary", scope: "per-sender", intent: "home", stored: "main" },
    { key: "agent:main:global", scope: "global", intent: "home", stored: "global" },
    { key: "agent:main:main", scope: "per-sender", intent: "exact", stored: "agent:main:main" },
    { key: "agent:main:global", scope: "global", intent: "exact", stored: "agent:main:global" },
  ] as const)(
    "persists $intent $key as the compatible string $stored",
    async ({ key, scope, intent, stored }) => {
      const stateDir = await makeTempStateDir();
      const remember = createRememberSessionKeyWriter({
        buildScopeKey: (sessionKey, sessionScope) =>
          buildTuiLastSessionScopeKey({
            connectionUrl: "ws://127.0.0.1:18789",
            agentId: "main",
            sessionScope,
          }),
        reportFailure: (message) => {
          throw new Error(message);
        },
        write: (params) => writeTuiLastSessionKey({ ...params, stateDir }),
      });
      remember({ sessionKey: key, ...(intent === "home" ? { targetIntent: intent } : {}) }, scope);
      const scopeKey = buildTuiLastSessionScopeKey({
        connectionUrl: "ws://127.0.0.1:18789",
        agentId: "main",
        sessionScope: scope,
      });
      await expect(readTuiLastSessionKey({ stateDir, scopeKey })).resolves.toBe(stored);
      expect(
        readConfigMachineStateWithMetadata<string>(`tui.lastSession.${scopeKey}`, {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        })?.value.trim(),
      ).toBe(stored);
    },
  );

  it("reports the first write failure once and keeps later writes silent", async () => {
    const failures: string[] = [];
    const write = async () => {
      throw new Error("SQLITE_CORRUPT: database disk image is malformed");
    };
    const remember = createRememberSessionKeyWriter({
      buildScopeKey: (sessionKey) => `scope:${sessionKey}`,
      reportFailure: (message) => failures.push(message),
      write,
    });

    remember({ sessionKey: "agent:main:one" }, "per-sender");
    remember({ sessionKey: "agent:main:two" }, "per-sender");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(failures).toEqual(["SQLITE_CORRUPT: database disk image is malformed"]);
  });

  it("skips bare placeholders while forwarding qualified unknown session keys", async () => {
    const writes: string[] = [];
    const remember = createRememberSessionKeyWriter({
      buildScopeKey: (sessionKey) => sessionKey,
      reportFailure: () => {
        throw new Error("must not report");
      },
      write: async ({ sessionKey }) => {
        writes.push(sessionKey);
      },
    });

    remember({ sessionKey: "  " }, "per-sender");
    remember({ sessionKey: "unknown" }, "per-sender");
    remember({ sessionKey: "agent:main:unknown" }, "per-sender");
    remember({ sessionKey: "agent:main:kept" }, "per-sender");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(writes).toEqual(["agent:main:unknown", "agent:main:kept"]);
  });
});
