import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  addSessionMember,
  isSessionMember,
  listSessionMembers,
  removeSessionMember,
} from "./session-sharing-store.js";

describe("session sharing store", () => {
  it("refuses revoked authority after worker admission yields without publishing", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:revoked-member-writer" };
      await upsertSessionEntryCore(scope, { sessionId: "revoked-member-writer", updatedAt: 1 });
      let authorized = true;
      const adding = addSessionMember(
        scope,
        { identityId: "guest", addedBy: "owner" },
        {
          assertCurrent() {
            if (!authorized) {
              throw new Error("sharing manager changed");
            }
          },
        },
      );
      authorized = false;
      await expect(adding).rejects.toThrow("sharing manager changed");
      expect(listSessionMembers(scope)).toEqual([]);
    });
  });

  it("publishes committed membership before completion and never publishes rejected changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      const changes: SessionRowChange[] = [];
      const members: string[][] = [];
      const stop = sessionChanges.subscribe((change) => {
        if (!("sessionKey" in change) || change.sessionKey !== scope.sessionKey) {
          return;
        }
        changes.push(change);
        members.push(listSessionMembers(scope).map((member) => member.identityId));
      });
      try {
        const adding = addSessionMember(scope, { identityId: "guest", addedBy: "owner" });
        expect(changes).toEqual([]);
        await adding;
        expect(changes).toEqual([
          expect.objectContaining({
            agentId: scope.agentId,
            sessionKey: scope.sessionKey,
            storePath: resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env }),
          }),
        ]);
        expect(members).toEqual([["guest"]]);
        changes.length = 0;
        members.length = 0;
        await expect(removeSessionMember(scope, "guest", undefined, "replaced")).rejects.toThrow(
          "session changed",
        );
        expect(changes).toEqual([]);
        await removeSessionMember(scope, "guest");
        expect(members).toEqual([[]]);
      } finally {
        stop();
      }
    });
  });

  it("reads existing and missing memberships without opening or creating writable databases", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      const missingScope = { agentId: "missing", env, sessionKey: "agent:missing:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: scope.agentId, env });
      const missingPath = resolveOpenClawAgentSqlitePath({ agentId: missingScope.agentId, env });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();

      expect(listSessionMembers(scope)).toEqual([
        { identityId: "guest", addedBy: "owner", addedAt: 2 },
      ]);
      expect(isSessionMember(scope, "guest")).toBe(true);
      expect(isOpenClawAgentDatabaseOpen(databasePath)).toBe(false);
      expect(listSessionMembers(missingScope)).toEqual([]);
      expect(isSessionMember(missingScope, "guest")).toBe(false);
      expect(fs.existsSync(missingPath)).toBe(false);
    });
  });

  it("keeps deterministic membership rows", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-session-sharing-", scenario: "minimal" },
      async ({ env }) => {
        const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
        await upsertSessionEntryCore(scope, {
          sessionId: "session-main",
          updatedAt: 1,
          visibility: "shared",
        });
        expect(loadSessionEntry(scope)?.visibility).toBe("shared");

        expect(listSessionMembers(scope)).toEqual([]);
        expect(
          (await addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 }))
            .inserted,
        ).toBe(true);
        expect(
          (await addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 }))
            .inserted,
        ).toBe(true);

        expect(listSessionMembers(scope)).toEqual([
          { identityId: "alice", addedBy: "owner", addedAt: 3 },
          { identityId: "zoe", addedBy: "owner", addedAt: 2 },
        ]);
        expect(isSessionMember(scope, "alice")).toBe(true);
        expect(await removeSessionMember(scope, "alice")).toEqual({
          identityId: "alice",
          addedBy: "owner",
          addedAt: 3,
        });
        expect(await removeSessionMember(scope, "alice")).toBeNull();
      },
    );
  });

  it("does not recreate a missing canonical membership table", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-main", updatedAt: 1 });
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      database.db.exec("DROP TABLE session_members;");

      expect(() => listSessionMembers(scope)).toThrow(
        expect.objectContaining({
          name: "SessionMetadataUnavailableError",
          reason: "table-missing",
          missingTables: ["session_members"],
          cause: expect.objectContaining({
            message: expect.stringMatching(/no such table: session_members/),
          }),
        }),
      );
      expect(
        database.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_members'")
          .get(),
      ).toBeUndefined();
    });
  });

  it("refuses member writes whose expected session instance no longer matches", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 1 });

      // A write authorized against a now-replaced instance must not mutate the
      // live one under the same key.
      await expect(
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: "session-a",
        }),
      ).rejects.toThrow(/session changed/);
      expect(listSessionMembers(scope)).toEqual([]);

      expect(
        (
          await addSessionMember(scope, {
            identityId: "ok",
            addedBy: "owner",
            addedAt: 2,
            expectedSessionId: "session-b",
          })
        ).inserted,
      ).toBe(true);
      await expect(removeSessionMember(scope, "ok", undefined, "session-a")).rejects.toThrow(
        /session changed/,
      );
      expect(isSessionMember(scope, "ok")).toBe(true);
    });
  });

  it.each([
    ["identity without timestamps", "session-a", '{"sessionId":"session-a"}', true],
    ["empty identity", "", '{"sessionId":""}', true],
    ["opaque identity", " a\0🦞 ", JSON.stringify({ sessionId: " a\0🦞 " }), true],
    ["mismatched node", "session-b", '{"sessionId":"session-a"}', false],
    ["malformed JSON", "session-a", "{", false],
    ["array JSON", "session-a", '[{"sessionId":"session-a"}]', false],
    ["last duplicate wins", "session-a", '{"sessionId":false,"sessionId":"session-a"}', true],
    ["last duplicate invalid", "session-a", '{"sessionId":"session-a","sessionId":false}', false],
    ["literal NUL", "session-a", '{"sessionId":"session-a"}\0', false],
  ] as const)(
    "preserves membership identity checks for %s",
    async (_, sessionId, entryJson, valid) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
        const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
        await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
        await addSessionMember(scope, { identityId: "existing", addedBy: "owner", addedAt: 2 });
        const database = openOpenClawAgentDatabase({ agentId: "main", env });
        database.db
          .prepare(
            "UPDATE session_nodes SET current_session_id = ?, entry_json = ? WHERE session_key = ?",
          )
          .run(sessionId, entryJson, scope.sessionKey);

        const add = () =>
          addSessionMember(scope, { identityId: "new", addedBy: "owner", addedAt: 3 });
        const remove = () => removeSessionMember(scope, "existing");
        if (valid) {
          expect((await add()).inserted).toBe(true);
          expect(await remove()).toEqual({
            identityId: "existing",
            addedBy: "owner",
            addedAt: 2,
          });
        } else {
          await expect(add()).rejects.toThrow("session changed before sharing mutation");
          await expect(remove()).rejects.toThrow("session changed before sharing mutation");
          expect(listSessionMembers(scope)).toEqual([
            { identityId: "existing", addedBy: "owner", addedAt: 2 },
          ]);
        }
      });
    },
  );

  it("drops members when the session instance is replaced under the same key", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, {
        sessionId: "session-a",
        updatedAt: 1,
        visibility: "read-only",
      });
      expect(
        (await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 }))
          .inserted,
      ).toBe(true);
      expect(isSessionMember(scope, "guest")).toBe(true);

      // Reusing the canonical key with a new sessionId is a fresh session; a
      // stale member must not inherit access, and the replacement must start
      // shared even if the recreated entry copied a restricted visibility.
      await upsertSessionEntryCore(scope, {
        sessionId: "session-b",
        updatedAt: 3,
        visibility: "read-only",
      });
      expect(listSessionMembers(scope)).toEqual([]);
      expect(isSessionMember(scope, "guest")).toBe(false);
      // Replacement drops the copied restriction; absent visibility reads as
      // shared, so the fresh instance is not hidden or read-only.
      expect(loadSessionEntry(scope)?.visibility).toBeUndefined();

      // An in-place update that keeps the same sessionId preserves membership.
      expect(
        (await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 4 }))
          .inserted,
      ).toBe(true);
      await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 5 });
      expect(isSessionMember(scope, "guest")).toBe(true);
    });
  });

  it("rejects stale member writes after entry-only deletion leaves a placeholder", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const scope = { agentId: "main", env, sessionKey: "agent:main:main" };
      await upsertSessionEntryCore(scope, { sessionId: "session-a", updatedAt: 1 });
      expect(
        (await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 }))
          .inserted,
      ).toBe(true);

      await deleteSessionEntryLifecycle({
        agentId: "main",
        archiveTranscript: false,
        storePath: openOpenClawAgentDatabase({ agentId: "main", env }).path,
        target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      });

      expect(loadSessionEntry(scope)).toBeUndefined();
      expect(listSessionMembers(scope)).toEqual([]);
      await expect(
        addSessionMember(scope, {
          identityId: "stale",
          addedBy: "owner",
          expectedSessionId: "session-a",
        }),
      ).rejects.toThrow(/session changed/);
      await expect(
        addSessionMember(scope, {
          identityId: "planted",
          addedBy: "owner",
        }),
      ).rejects.toThrow(/session changed/);

      await upsertSessionEntryCore(scope, { sessionId: "session-b", updatedAt: 3 });
      expect(listSessionMembers(scope)).toEqual([]);
    });
  });
});
