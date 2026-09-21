import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  compareSessionProviderReview,
  readSessionProviderReview,
} from "./provider-review-store.js";
import type { SessionProviderReview } from "./provider-review.types.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";

const target = {
  agentId: "main",
  sessionKey: "agent:main:cron:provider-review",
  sessionId: "review-session",
  lifecycleRevision: "generation-1",
};
const review: SessionProviderReview = {
  id: "review-1",
  sessionId: target.sessionId,
  runId: "refused-run",
  provider: "openai",
  model: "test-model",
  runtimeId: "codex",
};
const assertCurrent = () => {};

it.each(["default", "shared"] as const)(
  "keeps %s review reads and exact compare-set off the caller's SQLite thread",
  async (store) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = openOpenClawAgentDatabase({
        agentId: target.agentId,
        ...(store === "shared" ? { path: state.statePath("shared-review.sqlite") } : {}),
      });
      const selectedTarget = { ...target, storePath: database.path };
      const original = {
        sessionId: target.sessionId,
        lifecycleRevision: target.lifecycleRevision,
        updatedAt: 1,
      };
      writeSessionEntry(database, target.sessionKey, original);
      const statementPrototype: StatementSync = Object.getPrototypeOf(
        database.db.prepare("SELECT 1"),
      );
      const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
      const methods = [
        vi.spyOn(statementPrototype, "all"),
        vi.spyOn(statementPrototype, "get"),
        vi.spyOn(statementPrototype, "iterate"),
        vi.spyOn(statementPrototype, "run"),
        vi.spyOn(databasePrototype, "exec"),
      ];
      try {
        expect(await readSessionProviderReview(selectedTarget, assertCurrent)).toMatchObject(
          original,
        );
        expect(
          await compareSessionProviderReview(selectedTarget, {
            expectedReview: undefined,
            nextReview: review,
            assertCurrent,
          }),
        ).toMatchObject({ ...original, providerReview: review });
        const newer = { ...review, id: "review-2" };
        await compareSessionProviderReview(selectedTarget, {
          expectedReview: review,
          nextReview: newer,
          assertCurrent,
        });
        for (const stale of [review, { ...newer, runId: "changed-run" }]) {
          await expect(
            compareSessionProviderReview(selectedTarget, {
              expectedReview: stale,
              nextReview: undefined,
              assertCurrent,
            }),
          ).rejects.toThrow("Provider review changed");
        }
        for (const staleTarget of [
          { ...selectedTarget, sessionId: "old-session" },
          { ...selectedTarget, lifecycleRevision: "old-generation" },
          { ...selectedTarget, lifecycleRevision: undefined },
        ]) {
          expect(await readSessionProviderReview(staleTarget, assertCurrent)).toBeUndefined();
          await expect(
            compareSessionProviderReview(staleTarget, {
              expectedReview: newer,
              nextReview: undefined,
              assertCurrent,
            }),
          ).rejects.toThrow("Provider review changed");
        }
        expect(
          (await readSessionProviderReview(selectedTarget, assertCurrent))?.providerReview,
        ).toEqual(newer);
        expect(
          (
            await compareSessionProviderReview(selectedTarget, {
              expectedReview: newer,
              nextReview: undefined,
              assertCurrent,
            })
          ).providerReview,
        ).toBeUndefined();
        for (const method of methods) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        for (const method of methods) {
          method.mockRestore();
        }
      }
    });
  },
);

it("rolls back a clear when current authority is revoked at commit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    writeSessionEntry(
      database,
      target.sessionKey,
      {
        sessionId: target.sessionId,
        lifecycleRevision: target.lifecycleRevision,
        updatedAt: 1,
        providerReview: review,
      },
      { providerReviewMutation: true },
    );
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let current = true;
    const admitted = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            current = false;
          }
          return callback(request, grant);
        }),
      );
    try {
      await expect(
        compareSessionProviderReview(target, {
          expectedReview: review,
          nextReview: undefined,
          assertCurrent() {
            if (!current) {
              throw new Error("Review authority revoked");
            }
          },
        }),
      ).rejects.toThrow("Review authority revoked");
      expect(current).toBe(false);
      expect(readExactSessionEntryRow(database, target.sessionKey)?.entry.providerReview).toEqual(
        review,
      );
    } finally {
      admitted.mockRestore();
    }
  });
});

it("preserves a current review through stale bookkeeping and drops it on lifecycle replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    const original = {
      sessionId: target.sessionId,
      lifecycleRevision: target.lifecycleRevision,
      updatedAt: 1,
    };
    writeSessionEntry(
      database,
      target.sessionKey,
      { ...original, providerReview: review },
      {
        providerReviewMutation: true,
      },
    );
    const stale = { ...original, updatedAt: 2, providerReview: undefined };
    expect(writeSessionEntry(database, target.sessionKey, stale).providerReview).toEqual(review);
    expect(
      writeSessionEntry(database, target.sessionKey, {
        ...original,
        lifecycleRevision: "generation-2",
        providerReview: review,
      }).providerReview,
    ).toBeUndefined();
  });
});
