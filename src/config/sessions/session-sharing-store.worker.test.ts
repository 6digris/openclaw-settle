import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { initializeSessionReadContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "../../gateway/server-methods/sessions-sharing.js";
import {
  identifiedClient,
  sessionSharingTestContext as context,
  soloClient,
} from "../../gateway/server-methods/sessions-sharing.test-support.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../gateway/server-methods/types.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { patchSessionEntryCore, upsertSessionEntryCore } from "./session-accessor.js";
import {
  addSessionMember,
  listSessionMembers,
  removeSessionMember,
} from "./session-sharing-store.js";
import { listSessionMembersInWorker } from "./session-transcript-worker-runtime.js";

it.runIf(process.platform !== "win32")(
  "repairs warm membership writer permission drift before add and remove complete",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:member-permission-drift" };
      await upsertSessionEntryCore(scope, { sessionId: "member-permission-drift", updatedAt: 1 });
      const warm = { identityId: "warm", addedBy: "owner", addedAt: 2 };
      await addSessionMember(scope, warm);
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const directory = path.dirname(databasePath);
      const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
      const member = { identityId: "guest", addedBy: "owner", addedAt: 3 };

      for (const action of ["add", "remove"] as const) {
        fs.chmodSync(directory, 0o1700);
        fs.chmodSync(databasePath, 0o4600);
        for (const file of files.slice(1)) {
          fs.chmodSync(file, 0o644);
        }
        if (action === "add") {
          expect(await addSessionMember(scope, member)).toEqual({ member, inserted: true });
        } else {
          expect(await removeSessionMember(scope, member.identityId)).toEqual(member);
        }
        expect.soft(fs.statSync(directory).mode & 0o7777, `${action}: agent directory`).toBe(0o700);
        for (const file of files) {
          expect
            .soft(fs.statSync(file).mode & 0o7777, `${action}: ${path.basename(file)}`)
            .toBe(0o600);
        }
        expect(listSessionMembers(scope)).toEqual(action === "add" ? [member, warm] : [warm]);
      }
    });
  },
);

it("reads complete current member rows without executing SQLite on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:worker-members" };
    const entry = { sessionId: "worker-members", updatedAt: 1 };
    await patchSessionEntryCore(scope, () => entry, {
      fallbackEntry: entry,
      skipMaintenance: true,
    });
    await addSessionMember(scope, {
      identityId: "zoe",
      addedBy: "actor-evidence:unknown",
      addedAt: 2,
    });
    await addSessionMember(scope, {
      identityId: "alice",
      addedBy: "actor-evidence:unattributed",
      addedAt: 3,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const databasePrototype: DatabaseSync = Object.getPrototypeOf(database.db);
    const methods = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
      vi.spyOn(databasePrototype, "exec"),
    ];
    try {
      expect(await listSessionMembersInWorker(scope)).toEqual([
        { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
        { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
      ]);
      for (const method of methods) {
        expect(method).not.toHaveBeenCalled();
      }
    } finally {
      for (const method of methods) {
        method.mockRestore();
      }
    }
    await addSessionMember(scope, { identityId: "bob", addedBy: "owner", addedAt: 4 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "alice", addedBy: "actor-evidence:unattributed", addedAt: 3 },
      { identityId: "bob", addedBy: "owner", addedAt: 4 },
      { identityId: "zoe", addedBy: "actor-evidence:unknown", addedAt: 2 },
    ]);
    const missing = { agentId: "missing", sessionKey: "agent:missing:main" };
    expect(await listSessionMembersInWorker(missing)).toEqual([]);
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "missing" }))).toBe(false);
  });
});

it("retains the physical owner and logical partition of a shared member store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: state.statePath("shared-members.sqlite"),
    });
    const scope = { agentId: "other", sessionKey: "agent:other:members", storePath: database.path };
    await upsertSessionEntryCore(scope, { sessionId: "other-members", updatedAt: 1 });
    await addSessionMember(scope, {
      identityId: "other-guest",
      addedBy: "other-owner",
      addedAt: 2,
    });
    const sibling = { ...scope, agentId: "main", sessionKey: "agent:main:members" };
    await upsertSessionEntryCore(sibling, { sessionId: "main-members", updatedAt: 1 });
    await addSessionMember(sibling, {
      identityId: "main-guest",
      addedBy: "main-owner",
      addedAt: 3,
    });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "other-guest", addedBy: "other-owner", addedAt: 2 },
    ]);
    expect(database.agentId).toBe("main");
  });
});

it("keeps process-local incognito membership with its native owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:dashboard:incognito-members" };
    expect(await listSessionMembersInWorker(scope)).toEqual([]);
    await upsertSessionEntryCore(scope, {
      sessionId: "incognito-members",
      updatedAt: 1,
      incognito: true,
    });
    await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    expect(await listSessionMembersInWorker(scope)).toEqual([
      { identityId: "guest", addedBy: "owner", addedAt: 2 },
    ]);
  });
});

async function call(
  method: "session.members.list" | "session.members.listEvidence",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  client: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionSharingHandlers[method]?.({
    req: { type: "req", id: "members-worker-test", method },
    isWebchatConnect: () => false,
    params,
    client,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  });
  return responses;
}

it.each(["session.members.list", "session.members.listEvidence"] as const)(
  "%s reads full member rows off the Gateway thread, including cached statements",
  async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:worker-members" };
      await upsertSessionEntryCore(scope, { sessionId: "worker-members", updatedAt: 1 });
      await addSessionMember(scope, { identityId: "zoe", addedBy: "owner", addedAt: 2 });
      await addSessionMember(scope, { identityId: "alice", addedBy: "owner", addedAt: 3 });
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      // Observe native execution, including statements prepared before the request.
      const all = vi.spyOn(prototype, "all");
      const iterate = vi.spyOn(prototype, "iterate");
      try {
        for (let round = 0; round < 2; round++) {
          const result = await call(method, { sessionKey: scope.sessionKey }, requestContext);
          expect(result[0]?.[1]).toMatchObject({
            members: [
              { identityId: "alice", addedBy: "owner", addedAt: 3 },
              { identityId: "zoe", addedBy: "owner", addedAt: 2 },
            ],
          });
        }
        expect(
          [...all.mock.contexts, ...iterate.mock.contexts]
            .map((statement) => (statement as StatementSync).sourceSQL)
            .filter((sql) => /from ["`]?session_members["`]?/i.test(sql)),
        ).toEqual([]);
      } finally {
        all.mockRestore();
        iterate.mockRestore();
      }
    });
  },
);

it("rechecks the current manager after the membership read yields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:member-reader-authority" };
    await upsertSessionEntryCore(scope, {
      sessionId: "member-reader-authority",
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: "owner" },
    });
    await addSessionMember(scope, { identityId: "guest", addedBy: "owner", addedAt: 2 });
    const client = identifiedClient("owner");
    const requestContext = context(vi.fn());
    await initializeSessionReadContext(requestContext);
    const pending = call(
      "session.members.listEvidence",
      { sessionKey: scope.sessionKey },
      requestContext,
      client,
    );
    client.authenticatedUserProfile = identifiedClient("other").authenticatedUserProfile;
    await expect(pending).rejects.toThrow("session ownership changed before sharing read");
  });
});

it.each(["add", "remove"] as const)(
  "session.members.%s commits member rows off the Gateway thread before publication",
  async (action) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:member-writer" };
      await upsertSessionEntryCore(scope, {
        sessionId: "member-writer",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      if (action === "remove") {
        await addSessionMember(scope, { identityId: "owner", addedBy: "owner", addedAt: 2 });
      }
      const requestContext = context(vi.fn());
      await initializeSessionReadContext(requestContext);
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
      const execution = ["all", "get", "iterate", "run"] as const;
      const methods = execution.map((method) => vi.spyOn(prototype, method));
      const responses: Parameters<RespondFn>[] = [];
      try {
        await sessionSharingHandlers[`session.members.${action}`]?.({
          req: { type: "req", id: "member-writer-test", method: `session.members.${action}` },
          params: { sessionKey: scope.sessionKey, identityId: "owner" },
          client: identifiedClient("owner"),
          isWebchatConnect: () => false,
          context: requestContext,
          respond: (...response: Parameters<RespondFn>) => responses.push(response),
        });
        expect(responses[0]?.[0]).toBe(true);
        expect(
          methods
            .flatMap((method) => method.mock.contexts)
            .map((statement) => (statement as StatementSync).sourceSQL)
            .filter((sql) =>
              /(?:insert into|delete from|update) ["`]?session_members["`]?/i.test(sql),
            ),
        ).toEqual([]);
      } finally {
        for (const method of methods) {
          method.mockRestore();
        }
      }
      expect(await listSessionMembersInWorker(scope)).toEqual(
        action === "add"
          ? [expect.objectContaining({ identityId: "owner", addedBy: "owner" })]
          : [],
      );
      expect(requestContext.broadcast).toHaveBeenCalledWith(
        "session.sharing",
        expect.objectContaining({ action: action === "add" ? "member-added" : "member-removed" }),
        expect.anything(),
      );
    });
  },
);
