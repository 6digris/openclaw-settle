import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  acceptSessionEventStoreTestConfig,
  captureSessionEventStoreTestConfig,
} from "../../test/helpers/infra/session-event-store.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { registerSessionStateWatch } from "../sessions/session-state-watches.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  agentCommand,
  compactionTestRuntime,
  compactionTestState as state,
  makeCompactionResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath,
} from "./agent-command.compaction.test-support.js";
import { waitForSessionMaintenance } from "./session-maintenance/coordinator.js";

registerAgentCommandCompactionTestHooks();

it.each([false, true])(
  "retains registered watcher ownership before embedded command preparation waits (replaced=%s)",
  async (replaceStore) => {
    const config = expectDefined(state.cfg, "command configuration");
    const storePath = requireCompactionStorePath();
    const stateDir = path.dirname(storePath);
    const watcher = "agent:coordinator:main";
    const sessionKey = "agent:main:explicit:watcher-store-command";
    const sessionId = "watcher-store-command";
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const restoreConfig = captureSessionEventStoreTestConfig();
      const entered = createDeferred();
      const release = createDeferred();
      let command: ReturnType<typeof agentCommand> | undefined;
      try {
        acceptSessionEventStoreTestConfig(config);
        const entry: InternalSessionEntry = {
          sessionId,
          updatedAt: Date.now(),
          sessionDiffBaselineCapture: compactionTestRuntime.createSessionDiffBaselineCaptureClaim(),
        };
        await compactionTestRuntime.replaceSessionEntry({ sessionKey, storePath }, entry);
        expect(
          registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: sessionKey }),
        ).toBe(true);
        state.captureSessionDiffBaselineMock.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return {
            version: 1,
            sessionId,
            root: expectDefined(state.workspaceDir, "workspace"),
            files: [],
          };
        });
        state.runAgentAttemptMock.mockResolvedValueOnce(
          makeCompactionResult({
            sessionId,
            text: "Command completed.",
            runner: "embedded",
            agentHarnessId: "openclaw",
          }),
        );
        command = agentCommand({ message: "continue", sessionId, sessionKey });
        await Promise.race([
          entered.promise,
          command.then(() => {
            throw new Error("Command did not reach the baseline capture pause");
          }),
        ]);
        if (replaceStore) {
          state.cfg = {
            ...config,
            session: {
              ...config.session,
              store: path.join(stateDir, "replacement", "{agentId}", "sessions.json"),
            },
          };
          acceptSessionEventStoreTestConfig(state.cfg);
          expect(
            registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: sessionKey }),
          ).toBe(true);
        }
        const { db } = openOpenClawStateDatabase();
        const readWatch = () =>
          db
            .prepare(
              "SELECT * FROM session_watch_cursors WHERE watcher_session_key = ? AND target_session_key = ?",
            )
            .get(watcher, sessionKey);
        const admittedWatch = readWatch();
        release.resolve();
        await command;
        await waitForSessionMaintenance(sessionKey);

        expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
        expect(listSessionStateEventsSince(sessionKey, "main", 0).events).toContainEqual(
          expect.objectContaining({ kind: "human_direct_message", sessionId }),
        );
        if (replaceStore) {
          expect.soft(readWatch()).toEqual(admittedWatch);
          expect(peekSystemEventEntries(watcher)).toEqual([]);
        } else {
          expect(peekSystemEventEntries(watcher)).toHaveLength(1);
        }
      } finally {
        release.resolve();
        await Promise.allSettled([command]);
        await waitForSessionMaintenance(sessionKey);
        state.cfg = config;
        resetSystemEventsForTest();
        restoreConfig();
      }
    });
  },
);
