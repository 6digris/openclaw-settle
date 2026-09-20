import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  readSessionColdTranscript,
  SessionTranscriptColdError,
} from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import * as hydration from "../config/sessions/session-transcript-hydration.js";
import { SessionTranscriptStorageUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  recordOpenClawAgentDatabaseOpenFailure,
  clearOpenClawAgentDatabaseOpenFailure,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionPreviewItemsFromTranscript } from "./session-transcript-preview.js";
import { readTalkRealtimeInitialItems } from "./talk/session-history.js";

it("keeps missing preview storage absent and propagates terminal read refusal", async () => {
  await withOpenClawTestState({ label: "preview-reader-refusal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "preview",
      sessionKey: "agent:main:preview",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await expect(
      readSessionPreviewItemsFromTranscript(scope, 3, 100, "model-context"),
    ).rejects.toBeInstanceOf(SessionTranscriptStorageUnavailableError);
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const refusal = new Error("Synthetic terminal database refusal");
    recordOpenClawAgentDatabaseOpenFailure(scope.storePath, refusal);
    try {
      await expect(
        readSessionPreviewItemsFromTranscript(scope, 3, 100, "model-context"),
      ).rejects.toThrow(refusal);
    } finally {
      clearOpenClawAgentDatabaseOpenFailure(scope.storePath);
    }
  });
});

it("restores cold Talk history through its existing owner before bounded hydration", async () => {
  await withOpenClawTestState({ label: "preview-cold-history" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    );
    const history = SessionManager.inMemory("/synthetic/cold-history");
    history.newSession({ id: fixture.scope.sessionId });
    history.appendMessage({ role: "user", content: "Archived question", timestamp: 1 });
    history.appendMessage({ role: "user", content: "Archived followup", timestamp: 2 });
    await replaceTranscriptEvents(fixture.scope, history.getPersistedEntries());
    await waitForSessionTranscriptProjection(fixture.scope);
    fixture
      .database()
      .prepare(
        "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
      )
      .run(fixture.scope.sessionId);
    const expected = [
      { role: "user", text: "Archived question" },
      { role: "user", text: "Archived followup" },
    ];
    expect(
      await readSessionPreviewItemsFromTranscript(fixture.scope, 16, 800, "model-context"),
    ).toEqual(expected);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    await expect(
      readSessionPreviewItemsFromTranscript(fixture.scope, 16, 800, "model-context"),
    ).rejects.toBeInstanceOf(SessionTranscriptColdError);
    await replaceSessionEntry(fixture.scope, { sessionId: fixture.scope.sessionId, updatedAt: 1 });
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeDefined();
    const items = await readTalkRealtimeInitialItems(
      { ...fixture.scope, canonicalKey: fixture.scope.sessionKey },
      () => undefined,
    );
    expect(items).toEqual(expected);
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeUndefined();
  });
});

it("rejects Talk history when its live authority is revoked during real hydration", async () => {
  await withOpenClawTestState({ label: "preview-authority" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "preview",
      sessionKey: "agent:main:preview",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    SessionManager.open(scope).appendMessage({
      role: "user",
      content: "retained history",
      timestamp: 1,
    });
    await waitForSessionTranscriptProjection(scope);
    const received = createDeferredCore();
    const release = createDeferredCore();
    const prepare = hydration.prepareSessionTranscriptHydration;
    const held = vi
      .spyOn(hydration, "prepareSessionTranscriptHydration")
      .mockImplementationOnce((...args) => {
        const prepared = prepare(...args);
        return {
          ...prepared,
          read: async () => {
            const snapshot = await prepared.read();
            received.resolve();
            await release.promise;
            return snapshot;
          },
        };
      });
    let current = true;
    const pending = readTalkRealtimeInitialItems(
      { ...scope, canonicalKey: scope.sessionKey },
      () => {
        if (!current) {
          throw new Error("Synthetic Talk authority revoked");
        }
      },
    );
    const rejected = expect(pending).rejects.toThrow("Synthetic Talk authority revoked");
    try {
      await received.promise;
      current = false;
      release.resolve();
      await rejected;
      expect(await readSessionPreviewItemsFromTranscript(scope, 16, 800, "model-context")).toEqual([
        { role: "user", text: "retained history" },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      held.mockRestore();
    }
  });
});
