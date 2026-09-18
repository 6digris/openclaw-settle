import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  getSessionEntry,
  isValidAgentHarnessSessionStoreEntry,
  upsertSessionEntry,
} from "../plugin-sdk/session-store-runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as rowInputs from "./session-utils-row.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

it.each(["preparation", "materialization"] as const)(
  "discards prepared placement absence after publication during %s",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const targets = Array.from({ length: 3 }, (_, index) => ({
        agentId: "main",
        sessionKey: `agent:main:placement-${index}`,
        sessionId: `placement-${index}`,
      }));
      for (const target of targets) {
        replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
      }
      const placements = createWorkerSessionPlacementStore();
      const projection = await createSessionRowProjection({
        cfg: { agents: { list: [{ id: "main", default: true }] } },
        getModelCatalog: async () => [],
        placementFactsReader: placements,
      });
      try {
        await projection.ensureMaterialized();
        const target = targets[2]!;
        const query = { agentId: target.agentId, key: target.sessionKey };
        expect(projection.snapshot(query).row?.placement).toBeUndefined();
        const publish = () =>
          reportPlacementTransition(undefined, placements.startDispatch(target));
        if (phase === "preparation") {
          const read = placements.getProjectionFacts.bind(placements);
          vi.spyOn(placements, "getProjectionFacts").mockImplementationOnce((ids) => {
            const facts = read(ids);
            publish();
            return facts;
          });
        } else {
          const read = rowInputs.readSessionRowInputs;
          vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementationOnce((params) => {
            publish();
            return read(params);
          });
        }
        sessionChanges.emit({ all: true, scope: "acp" });
        await projection.ensureMaterialized();
        expect(projection.dirtyRowCount).toBe(0);
        expect(projection.snapshot(query).row?.placement?.state).toBe("requested");
      } finally {
        projection.dispose();
      }
    });
  },
);

it.each([
  { read: "prepared", locked: false },
  { read: "prepared", locked: true },
  { read: "exact", locked: false },
  { read: "exact", locked: true },
] as const)(
  "retains placement recovery for persisted requested IDs ($read, harness locked: $locked)",
  async ({ read, locked }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:placement-identity" };
      const entry = {
        sessionId: "placement-identity",
        updatedAt: 1,
        ...(locked ? { modelSelectionLocked: true, agentHarnessId: "synthetic-harness" } : {}),
      };
      await upsertSessionEntry({ ...scope, entry });
      const placements = createWorkerSessionPlacementStore();
      placements.startDispatch({ ...scope, sessionId: entry.sessionId });
      placements.fail({ sessionId: entry.sessionId, recoveryError: "Fixture startup failed" });
      const projection = await createSessionRowProjection({
        cfg: { agents: { list: [{ id: "main", default: true }] } },
        getModelCatalog: async () => [],
        placementFactsReader: placements,
      });
      try {
        await projection.ensureMaterialized();
        const query = { agentId: scope.agentId, key: scope.sessionKey };
        const recovery = {
          state: "failed",
          recoveryError: "Fixture startup failed",
          recoveryAction: "restart",
        };
        expect(projection.snapshot(query).row?.placement).toMatchObject(recovery);
        const requestedId = ` ${entry.sessionId} `;
        await upsertSessionEntry({
          ...scope,
          entry: { ...entry, sessionId: requestedId, archivedAt: read === "exact" ? 1 : undefined },
        });
        await projection.ensureMaterialized();
        const persisted = getSessionEntry(scope)!;
        expect(persisted.sessionId).toBe(requestedId);
        if (locked) {
          expect(isValidAgentHarnessSessionStoreEntry(scope.sessionKey, persisted)).toBe(true);
        }
        if (read === "exact") {
          expect(projection.capture(query)?.materialized).toBeUndefined();
        }
        expect(projection.snapshot(query).row).toMatchObject({
          sessionId: requestedId,
          placement: recovery,
        });
        expect(getSessionEntry(scope)?.sessionId).toBe(requestedId);
      } finally {
        projection.dispose();
      }
    });
  },
);
