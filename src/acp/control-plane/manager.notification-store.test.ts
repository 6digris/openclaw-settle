import { realpathSync } from "node:fs";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  acceptSessionEventStoreTestConfig,
  captureSessionEventStoreTestConfig,
} from "../../../test/helpers/infra/session-event-store.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { publishSystemEventStoreSelection } from "../../infra/system-event-ownership.js";
import { drainSystemEventEntries, peekSystemEventEntries } from "../../infra/system-events.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { readCursor } from "../../sessions/session-state-events.kernel.js";
import { registerSessionStateWatch } from "../../sessions/session-state-watches.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { AcpSessionManager } from "./manager.core.js";
import { disposeAcpSessionManagerInstance } from "./manager.lifecycle.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it.each([false, true])(
  "retains registered watcher ownership across ACP actor admission (replaced=%s)",
  async (replaced) => {
    const restoreConfig = captureSessionEventStoreTestConfig();
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const source = "agent:main:acp:notification-source";
        const watcher = "agent:main:notification-watcher";
        const originalStore = state.statePath("original.sqlite");
        const replacementStore = state.statePath("replacement.sqlite");
        const cfg: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          acp: { enabled: true, backend: "synthetic" },
          session: { store: originalStore },
        };
        acceptSessionEventStoreTestConfig(cfg);
        replaceSessionEntrySync(
          { sessionKey: source, storePath: originalStore },
          { sessionId: "admitted-source", lifecycleRevision: "source-revision", updatedAt: 1 },
        );
        replaceSessionEntrySync(
          { sessionKey: watcher, storePath: originalStore },
          { sessionId: "original-watcher", updatedAt: 1 },
        );
        expect(
          registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: source }),
        ).toBe(true);
        const entered = createDeferred();
        const release = createDeferred();
        const getStatus = vi.fn<NonNullable<AcpRuntime["getStatus"]>>(async () => ({
          summary: "ready",
        }));
        const runTurn = vi.fn<AcpRuntime["runTurn"]>(async function* () {
          yield { type: "done" as const };
        });
        const runtime: AcpRuntime = {
          ownerAwareSessions: 1,
          ensureSession: async (input) => ({
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            backend: "synthetic",
            runtimeSessionName: "notification-runtime",
          }),
          getStatus,
          runTurn,
          async prepareFreshSession() {},
          async cancel() {},
          async close() {},
        };
        const backend = { id: "synthetic", runtime };
        const manager = new AcpSessionManager({
          ...DEFAULT_DEPS,
          requireRuntimeBackend: () => backend,
          getRuntimeBackend: () => backend,
        });
        const target = { cfg, sessionKey: source, agentId: "main" };
        const pending: Promise<unknown>[] = [];
        try {
          await manager.initializeSession({ ...target, agent: "main", mode: "persistent" });
          getStatus.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return { summary: "ready" };
          });
          const actor = manager.getSessionStatus(target);
          pending.push(actor);
          await Promise.race([
            entered.promise,
            actor.then(() => {
              throw new Error("status completed before the actor gate was reached");
            }),
          ]);
          const requestId = "admitted-notification-turn";
          const turn = manager.runTurn({
            ...target,
            admittedRunContext: createTestAdmittedRunContext(requestId),
            provenance: "human",
            mode: "prompt",
            text: "message admitted in the original store",
            requestId,
          });
          pending.push(turn);
          const settlement = Promise.allSettled(pending);
          expect(runTurn).not.toHaveBeenCalled();
          if (replaced) {
            acceptSessionEventStoreTestConfig({ ...cfg, session: { store: replacementStore } });
            replaceSessionEntrySync(
              { sessionKey: watcher, storePath: replacementStore },
              { sessionId: "replacement-watcher", updatedAt: 1 },
            );
            expect(
              registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: source }),
            ).toBe(true);
          }
          const { db } = openOpenClawStateDatabase();
          const before = expectDefined(readCursor(db, watcher, source), "registered watcher");
          release.resolve();
          expect((await settlement).map((result) => result.status)).toEqual([
            "fulfilled",
            "fulfilled",
          ]);
          expect(runTurn).toHaveBeenCalledOnce();
          expect(
            listSessionStateEventsSince(source, "main", 0).events.map((event) => ({
              kind: event.kind,
              sessionId: event.sessionId,
              summary: event.summary,
            })),
          ).toEqual([
            {
              kind: "human_direct_message",
              sessionId: "admitted-source",
              summary: "human message via acp",
            },
          ]);
          if (replaced) {
            expect.soft(readCursor(db, watcher, source)).toEqual(before);
            expect(peekSystemEventEntries(watcher)).toEqual([]);
          } else {
            expect(readCursor(db, watcher, source)).toEqual({
              ...before,
              material_sequence: 1,
              notified_sequence: 1,
              updated_at: expect.any(Number),
            });
            expect(peekSystemEventEntries(watcher)).toEqual([
              {
                id: expect.any(String),
                ts: expect.any(Number),
                text: `Session "${source}" changed (other actor). Reconcile before acting: session_status sessionKey "${source}" changesSince 0.`,
                contextKey: `session-state:${Buffer.from(source).toString("hex")}`,
                deliveryContext: undefined,
                sessionStorePath: realpathSync(originalStore),
              },
            ]);
          }
        } finally {
          release.resolve();
          await Promise.allSettled(pending);
          try {
            await disposeAcpSessionManagerInstance(manager, "test-complete");
          } finally {
            drainSystemEventEntries(watcher);
            publishSystemEventStoreSelection(undefined);
          }
        }
      });
    } finally {
      restoreConfig();
    }
  },
);
