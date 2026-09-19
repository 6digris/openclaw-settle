import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureSessionEventStoreTestConfig } from "../../../test/helpers/infra/session-event-store.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { publishSystemEventStoreConfig } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readCursor } from "../../sessions/session-state-events.kernel.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import "../test-helpers/fast-openclaw-tools-sessions.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

describe("sessions_send watch admission", () => {
  it.each([false, true])(
    "retains the requester's store through suspended target resolution (replaced: %s)",
    async (replaced) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
        const restoreStore = captureSessionEventStoreTestConfig();
        const original = path.join(stateDir, "original");
        const replacement = path.join(stateDir, "replacement");
        const selected = path.join(stateDir, "selected");
        const replacementAlias = path.join(stateDir, "replacement-selected");
        const requester = "agent:main:main";
        const target = "agent:main:dashboard:child";
        const config: OpenClawConfig = {
          agents: { entries: { main: {} } },
          session: { store: path.join(selected, "sessions.json") },
          tools: { sessions: { visibility: "all" } },
        };
        const resolving = createDeferredCore();
        const resolved = createDeferredCore<{ key: string; agentId: string }>();
        const callGateway = vi.fn();
        callGateway.mockImplementation(async (request: { method: string }) => {
          if (request.method === "sessions.resolve") {
            resolving.resolve();
            return resolved.promise;
          }
          if (request.method === "agent") {
            return { runId: "watched-child-run", status: "accepted" };
          }
          if (request.method === "agent.wait") {
            return {
              status: "ok",
              terminalReply: { disposition: "visible", text: "Child reply" },
            };
          }
          throw new Error(`Unexpected Gateway request: ${request.method}`);
        });
        const tool = createSessionsSendTool({ agentSessionKey: requester, config, callGateway });
        let pending: ReturnType<typeof tool.execute> | undefined;
        try {
          for (const directory of [original, replacement]) {
            await fs.mkdir(directory);
            const storePath = path.join(directory, "sessions.json");
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: requester, storePath },
              { sessionId: `parent-${path.basename(directory)}`, updatedAt: 1 },
            );
            await upsertSessionEntryCore(
              { agentId: "main", sessionKey: target, storePath },
              {
                sessionId: `child-${path.basename(directory)}`,
                updatedAt: 1,
                spawnedBy: requester,
                parentSessionKey: requester,
                spawnDepth: 1,
              },
            );
          }
          await fs.symlink(original, selected, "junction");
          await fs.symlink(replacement, replacementAlias, "junction");
          publishSystemEventStoreConfig(config);
          pending = tool.execute("watch-child", {
            label: "child",
            message: "Return your result",
            watch: true,
            timeoutSeconds: 1,
          });
          await resolving.promise;
          if (replaced) {
            await fs.rename(replacementAlias, selected);
          }
          publishSystemEventStoreConfig(config);
          resolved.resolve({ key: target, agentId: "main" });

          const result = await pending;
          expect(result.details).toMatchObject({
            status: "ok",
            reply: "Child reply",
            watched: !replaced,
          });
          const cursor = readCursor(openOpenClawStateDatabase().db, requester, target);
          if (replaced) {
            expect(cursor).toBeUndefined();
          } else {
            expect(cursor).toMatchObject({
              watcher_store_path: path.join(await fs.realpath(original), "openclaw-agent.sqlite"),
              provenance: "explicit",
            });
          }
        } finally {
          resolved.resolve({ key: target, agentId: "main" });
          try {
            await pending;
          } finally {
            restoreStore();
          }
        }
      });
    },
  );
});
