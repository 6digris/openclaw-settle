import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSessionVisibilityChecker } from "../plugin-sdk/session-visibility.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";

vi.mock("./prepared-model-catalog.js", () => ({
  loadPublishedPreparedModelCatalog: async () => [],
}));
vi.mock("../status/status-text.js", () => ({
  buildStatusText: async () => "Session status",
}));

describe("session_status shared SQLite ownership", () => {
  it.each(["main", "global"])(
    "resolves current to the attached research %s session before selecting the fixed-store owner",
    async (name) => {
      await withOpenClawTestState(
        { label: "session-status-shared", scenario: "empty" },
        async (state) => {
          const storePath = state.statePath("shared.sqlite");
          const cfg: OpenClawConfig = {
            session: { store: storePath, scope: "global" },
            agents: {
              ownership: "explicit",
              defaults: {
                model: "openai/gpt-5.4",
                sessionStore: { agentId: "ops" },
                workspace: state.workspaceDir,
              },
              entries: { ops: {}, research: {} },
            },
            tools: { agentToAgent: { enabled: false } },
          };
          await state.writeConfig(cfg);
          openOpenClawAgentDatabase({ agentId: "ops", path: storePath });
          const sessionKey = `agent:research:${name}`;
          const scope = { agentId: "research", sessionKey, storePath };
          const sessionId = `research-${name}`;
          await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
          await upsertSessionEntryCore(
            { agentId: "ops", sessionKey: "agent:ops:global", storePath },
            { sessionId: "ops-global", updatedAt: 1 },
          );
          expect(inspectOpenClawAgentDatabaseOwner(storePath)).toEqual({
            status: "owned",
            agentId: "ops",
          });
          const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(
            (request) =>
              request.action === "status" &&
              request.requesterSessionKey === sessionKey &&
              request.targetSessionKey === sessionKey
                ? { expectedSessionId: sessionId }
                : undefined,
          );
          try {
            const tool = createSessionStatusTool({
              agentSessionKey: sessionKey,
              requesterAgentIdOverride: "research",
              config: cfg,
            });
            const result = await tool.execute("attached-current", { sessionKey: "current" });
            expect(result.details).toMatchObject({ ok: true, agentId: "research", sessionKey });
            expect(loadSessionEntry(scope)?.sessionId).toBe(sessionId);

            for (const foreignKey of ["global", "agent:ops:global"]) {
              await expect(
                tool.execute("foreign-owner", { sessionKey: foreignKey }),
              ).rejects.toThrow("Agent-to-agent status is disabled");
            }

            await upsertSessionEntryCore(scope, {
              sessionId: `${sessionId}-replacement`,
              updatedAt: 2,
            });
            await expect(tool.execute("stale-grant", { sessionKey: "current" })).rejects.toThrow(
              "changed after access was granted",
            );
          } finally {
            unregister();
          }
        },
      );
    },
  );
});
