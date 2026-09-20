import fs from "node:fs/promises";
import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { agentDiscoveryMock, rpcReq, writeSessionStore } from "./test-helpers.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, defaultAgentWorkspace, openClient } =
  setupGatewaySessionsTestHarness();

test("write-scoped operators manage chat organization but not admin session settings", async () => {
  const { storePath } = await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: now },
      "topic-a": {
        sessionId: "sess-topic-a",
        updatedAt: now - 60_000,
        // Stored channel-derived name; a user rename (label) must beat it.
        displayName: "channel topic",
      },
      "topic-b": { sessionId: "sess-topic-b", updatedAt: now - 30_000 },
    },
  });

  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

  const { ws } = await openClient({ scopes: ["operator.write"] });
  try {
    const renamed = await rpcReq<{
      ok: true;
      entry: { label?: string; modelOverride?: string; providerOverride?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Trip planning",
      model: "openai/gpt-test-a",
    });
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true);
    expect(renamed.payload?.entry).toMatchObject({
      label: "Trip planning",
      modelOverride: "gpt-test-a",
      providerOverride: "openai",
    });

    const pinned = await rpcReq<{ ok: true; entry: { pinnedAt?: number } }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      pinned: true,
    });
    expect(pinned.ok).toBe(true);
    expect(pinned.payload?.entry.pinnedAt).toEqual(expect.any(Number));

    const organized = await rpcReq<{
      ok: true;
      entry: { category?: string; markedUnreadAt?: number };
    }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      category: "Travel",
      unread: true,
    });
    expect(organized.ok).toBe(true);
    expect(organized.payload?.entry.category).toBe("Travel");

    // Patched categories are absorbed into the gateway group catalog.
    const groupsAfterPatch = await rpcReq<{
      groups: Array<{ name: string; position: number }>;
      sectionOrder: string[];
    }>(ws, "sessions.groups.list", {});
    expect(groupsAfterPatch.ok).toBe(true);
    expect(groupsAfterPatch.payload?.groups).toContainEqual({ name: "Travel", position: 0 });
    expect(groupsAfterPatch.payload?.sectionOrder).toEqual([]);

    const reordered = await rpcReq<{
      ok: true;
      groups: Array<{ name: string }>;
      sectionOrder: string[];
    }>(ws, "sessions.groups.put", {
      names: ["Someday", "Travel"],
      sectionOrder: ["work", "category:Travel", "category:Missing", "ungrouped"],
    });
    expect(reordered.ok).toBe(true);
    expect(reordered.payload?.groups.map((group) => group.name)).toEqual(["Someday", "Travel"]);
    expect(reordered.payload?.sectionOrder).toEqual(["work", "category:Travel", "ungrouped"]);

    const canonicalDefaultAgentWorkspace = await fs.realpath(defaultAgentWorkspace);
    const defaultsUpdated = await rpcReq<{
      ok: true;
      defaults: Array<{ name: string; cwd?: string; worktree?: boolean }>;
    }>(ws, "sessions.groups.update", {
      name: "Travel",
      cwd: defaultAgentWorkspace,
      worktree: true,
    });
    expect(defaultsUpdated.ok).toBe(true);
    expect(defaultsUpdated.payload?.defaults).toContainEqual({
      name: "Travel",
      cwd: canonicalDefaultAgentWorkspace,
      worktree: true,
    });
    const renamedGroup = await rpcReq<{
      ok: true;
      sectionOrder: string[];
      updatedSessions?: number;
    }>(ws, "sessions.groups.rename", { name: "Travel", to: "Trips" });
    expect(renamedGroup.ok).toBe(true);
    expect(renamedGroup.payload?.updatedSessions).toBe(1);
    expect(renamedGroup.payload?.sectionOrder).toEqual(["work", "category:Trips", "ungrouped"]);
    const describedAfterRename = await rpcReq<{ session?: { category?: string } }>(
      ws,
      "sessions.describe",
      { key: "agent:main:topic-a" },
    );
    expect(describedAfterRename.ok).toBe(true);
    expect(describedAfterRename.payload?.session?.category).toBe("Trips");

    const deletedGroup = await rpcReq<{
      ok: true;
      sectionOrder: string[];
      updatedSessions?: number;
    }>(ws, "sessions.groups.delete", { name: "Trips" });
    expect(deletedGroup.ok).toBe(true);
    expect(deletedGroup.payload?.updatedSessions).toBe(1);
    expect(deletedGroup.payload?.sectionOrder).toEqual(["work", "ungrouped"]);

    const archived = await rpcReq<{ ok: true; entry: { archivedAt?: number } }>(
      ws,
      "sessions.patch",
      { key: "agent:main:topic-b", archived: true, expectedSessionId: "sess-topic-b" },
    );
    expect(archived.ok).toBe(true);
    expect(archived.payload?.entry.archivedAt).toEqual(expect.any(Number));

    const searched = await rpcReq<{
      sessions: Array<{ key: string; pinned?: boolean; displayName?: string }>;
    }>(ws, "sessions.list", { search: "trip plan" });
    expect(searched.ok).toBe(true);
    expect(searched.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:main:topic-a",
    ]);
    expect(searched.payload?.sessions[0]?.displayName).toBe("Trip planning");

    const archivedList = await rpcReq<{ sessions: Array<{ key: string }> }>(ws, "sessions.list", {
      archived: true,
    });
    expect(archivedList.ok).toBe(true);
    expect(archivedList.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:main:topic-b",
    ]);

    const unflaggedDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-b",
    });
    expect(unflaggedDeleteDenied.ok).toBe(false);
    expect(unflaggedDeleteDenied.error?.message).toContain("missing scope: operator.admin");

    const activeDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-a",
      archivedOnly: true,
    });
    expect(activeDeleteDenied.ok).toBe(false);
    expect(activeDeleteDenied.error?.message).toContain("Archive it first");

    const archivedDeleted = await rpcReq<{ ok: true }>(ws, "sessions.delete", {
      key: "agent:main:topic-b",
      archivedOnly: true,
    });
    expect(archivedDeleted.ok).toBe(true);
    const archivedAfterDelete = await rpcReq<{ sessions: Array<{ key: string }> }>(
      ws,
      "sessions.list",
      { archived: true },
    );
    expect(archivedAfterDelete.payload?.sessions).toEqual([]);

    const adminFieldDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      sendPolicy: "deny",
    });
    expect(adminFieldDenied.ok).toBe(false);
    expect(adminFieldDenied.error?.message).toContain("missing scope: operator.admin");

    const mixedFieldsDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Sneaky",
      model: null,
      verboseLevel: "full",
    });
    expect(mixedFieldsDenied.ok).toBe(false);
    expect(mixedFieldsDenied.error?.message).toContain("missing scope: operator.admin");
    expect(loadSessionEntry({ sessionKey: "agent:main:topic-a", storePath })).toMatchObject({
      label: "Trip planning",
      modelOverride: "gpt-test-a",
      providerOverride: "openai",
    });
    // Sticky configured-default persistence is handler policy and is covered by
    // sessions-mutations.sticky-model.test.ts; this dispatch proof asserts session state only.
  } finally {
    ws.close();
  }
});
