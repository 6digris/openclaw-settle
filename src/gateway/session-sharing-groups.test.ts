import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { migrateDoctorSessionGroups } from "../commands/doctor-session-groups.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { sessionGroupHandlers } from "./server-methods/sessions-groups.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import * as workspaceContainment from "./server-methods/workspace-path-containment.js";
import {
  listSessionGroupDefaults,
  listSessionGroups,
  putSessionGroups,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import {
  sharingPolicyClient as client,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";

afterEach(async () => {
  await flushPendingSessionsChangedEvents();
  closeOpenClawAgentDatabasesForTest();
});

describe("session sharing group mutations", () => {
  it("reuses group membership metadata and immediately observes changed member permissions", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      const cfg = {};
      putSessionGroups({ agentId: "main", cfg, names: ["Projects", "Personal"] });
      const scope = { agentId: "main", sessionKey: "agent:main:restricted-group-member" };
      await upsertSessionEntryCore(scope, {
        sessionId: "restricted-group-member",
        updatedAt: Date.now(),
        category: "Projects",
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: "owner@example.com" },
      });
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const readDefaults = async () => {
        const responses: Parameters<RespondFn>[] = [];
        await sessionGroupHandlers["sessions.groups.defaults"]!({
          req: { type: "req", id: "group-defaults-test", method: "sessions.groups.defaults" },
          params: { agentId: "main" },
          client: viewer,
          context,
          isWebchatConnect: () => true,
          respond: (...response) => responses.push(response),
        });
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0]).toBe(true);
        return responses[0]?.[1];
      };
      const database = expectDefined(
        getOpenClawAgentDatabaseIfOpen(scope),
        "seeded agent database",
      );
      const queries = trackSqliteStatementExecutions(database.db, ["entries"], (sql) =>
        /\bselect\b/i.test(sql) && /\bsession_nodes\b/.test(sql) && /\bentry_json\b/.test(sql)
          ? "entries"
          : null,
      );
      try {
        expect(await readDefaults()).toEqual({ defaults: [{ name: "Personal" }] });
        queries.counts.entries = 0;
        queries.rowCounts.entries = 0;
        for (let index = 0; index < 3; index++) {
          expect(await readDefaults()).toEqual({ defaults: [{ name: "Personal" }] });
        }
        expect(queries.counts.entries).toBe(0);
        expect(queries.rowCounts.entries).toBe(0);

        await upsertSessionEntryCore(scope, { category: "Personal" });
        expect(await readDefaults()).toEqual({ defaults: [{ name: "Projects" }] });
        await upsertSessionEntryCore(scope, { visibility: "shared" });
        expect(await readDefaults()).toEqual({
          defaults: [{ name: "Projects" }, { name: "Personal" }],
        });
      } finally {
        queries.restore();
      }
    });
  });

  it.each(["rename", "delete"])(
    "refreshes groups after %s rejects changed member authority",
    async (action) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await migrateDoctorSessionGroups({});
        putSessionGroups({ agentId: "main", cfg: {}, names: ["Old"] });
        const sessionKey = "agent:main:changed-group-authority";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "changed-group-authority",
            updatedAt: 1,
            category: "Old",
          },
        );
        const error = new SessionMutationAuthorizationChangedError({
          code: "INVALID_REQUEST",
          message: "member authority changed",
          details: { reason: "changed" },
        });
        const broadcastToConnIds = vi.fn();
        const respond = vi.fn();
        const context = {
          getRuntimeConfig: () => ({}),
          getSessionEventSubscriberConnIds: () => new Set(["group-observer"]),
          broadcastToConnIds,
        } as unknown as GatewayRequestContext;
        await expect(
          sessionGroupHandlers[`sessions.groups.${action}`]?.({
            params: { agentId: "main", name: "Old", ...(action === "rename" ? { to: "New" } : {}) },
            context,
            respond,
            sessionMutationAuthorization: {
              assertCurrent: () => {},
              assertTargetCurrent: () => {
                throw error;
              },
            },
          } as never),
        ).rejects.toMatchObject({
          name: "SessionMutationAuthorizationChangedError",
          error: {
            code: "INVALID_REQUEST",
            details: { reason: "changed" },
            message: expect.stringContaining("retry"),
          },
        });
        expect(respond).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.category).toBe("Old");
        expect(listSessionGroups("main")).toContainEqual({ name: "Old", position: 0 });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "groups", agentId: "main" }),
          new Set(["group-observer"]),
          expect.any(Object),
        );
      });
    },
  );
  it("refuses restricted group drops at put admission while allowing retained groups", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      putSessionGroups({ agentId: "main", cfg: {}, names: ["Projects"] });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-put-member" },
        {
          sessionId: "session-restricted-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = roleClient("none", "put-viewer");
      const context = { getRuntimeConfig: () => rolePolicyConfig() } as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { agentId: "main", names: [] },
          context,
        }).error,
      ).not.toBeNull();
      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.put",
          requestParams: { agentId: "main", names: [" Projects "] },
          context,
        }).error,
      ).toBeNull();
    });
  });

  it("rechecks late group members before committing a put drop", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      const groups = putSessionGroups({ agentId: "main", cfg: {}, names: ["Race"] });
      const viewer = roleClient("none", "put-viewer");
      const context = {
        getRuntimeConfig: () => rolePolicyConfig(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.put",
        requestParams: { agentId: "main", names: [] },
        context,
      });
      expect(authorization).toMatchObject({ error: null, authorization: expect.any(Object) });

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-put-member" },
        {
          sessionId: "session-late-put-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.put"]?.({
          params: { agentId: "main", names: [] },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroups("main")).toEqual(groups);
    });
  });

  it("rechecks group members before committing a defaults update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      putSessionGroups({ agentId: "main", cfg: {}, names: ["Race"] });
      updateSessionGroupDefaults("main", "Race", { cwd: "/repos/race", worktree: true });
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { agentId: "main", name: " Race ", cwd: null, worktree: false },
        context,
      });
      expect(authorization.error).toBeNull();

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:late-restricted-member" },
        {
          sessionId: "session-late-restricted-member",
          updatedAt: 1,
          visibility: "read-only",
          category: "Race",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );

      await expect(
        sessionGroupHandlers["sessions.groups.update"]?.({
          params: { agentId: "main", name: " Race ", cwd: null, worktree: false },
          client: viewer,
          context,
          sessionMutationAuthorization: authorization.authorization,
          respond: () => undefined,
        } as never),
      ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(listSessionGroupDefaults("main")).toEqual([
        { name: "Race", cwd: "/repos/race", worktree: true },
      ]);
    });
  });

  it("filters group defaults and blocks updates for sessions the caller cannot mutate", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      putSessionGroups({ agentId: "main", cfg: {}, names: ["Projects", "Personal"] });
      updateSessionGroupDefaults("main", "Projects", { cwd: "/repos/projects", worktree: true });
      updateSessionGroupDefaults("main", "Personal", { cwd: "/repos/personal", worktree: false });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-project" },
        {
          sessionId: "session-restricted-project",
          updatedAt: 1,
          visibility: "read-only",
          category: "Projects",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => ({}),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;

      expect(
        resolveSessionMutationAuthorization({
          client: viewer,
          method: "sessions.groups.update",
          requestParams: { agentId: "main", name: "Projects", cwd: null, worktree: false },
          context,
        }).error,
      ).toMatchObject({ details: { code: "SESSION_PARTICIPATION_REQUIRED" } });

      const responses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.defaults"]?.({
        params: { agentId: "main" },
        client: viewer,
        context,
        respond: (...response: Parameters<RespondFn>) => responses.push(response),
      } as never);
      expect(responses).toEqual([
        [
          true,
          { defaults: [{ name: "Personal", cwd: "/repos/personal", worktree: false }] },
          undefined,
        ],
      ]);

      const personalAuthorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams: { agentId: "main", name: "Personal", cwd: null, worktree: false },
        context,
      });
      expect(personalAuthorization.error).toBeNull();
      const updateResponses: Parameters<RespondFn>[] = [];
      await sessionGroupHandlers["sessions.groups.update"]?.({
        params: { agentId: "main", name: "Personal", cwd: null, worktree: false },
        client: viewer,
        context,
        sessionMutationAuthorization: personalAuthorization.authorization,
        respond: (...response: Parameters<RespondFn>) => updateResponses.push(response),
      } as never);
      expect(updateResponses).toEqual([
        [true, { ok: true, defaults: [{ name: "Personal", worktree: false }] }, undefined],
      ]);
    });
  });
  it("does not let alpha's restricted same-name member hide or block beta's defaults", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      const cfg = { agents: { ownership: "explicit" as const, entries: { alpha: {}, beta: {} } } };
      for (const agentId of ["alpha", "beta"]) {
        putSessionGroups({ cfg, agentId, names: ["Shared"] });
        updateSessionGroupDefaults(agentId, "Shared", {
          cwd: "/repos/" + agentId,
          worktree: agentId === "alpha",
        });
      }
      await upsertSessionEntryCore(
        { agentId: "alpha", sessionKey: "agent:alpha:restricted" },
        {
          sessionId: "alpha-restricted",
          updatedAt: 1,
          category: "Shared",
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = client({ user: "viewer@example.com" });
      const context = {
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      for (const agentId of ["alpha", "beta"]) {
        const respond = vi.fn();
        await sessionGroupHandlers["sessions.groups.defaults"]!({
          params: { agentId },
          client: viewer,
          context,
          respond,
        } as never);
        expect(respond).toHaveBeenCalledWith(
          true,
          {
            defaults:
              agentId === "alpha" ? [] : [{ name: "Shared", cwd: "/repos/beta", worktree: false }],
          },
          undefined,
        );
      }
      const requestParams = { agentId: "beta", name: "Shared", cwd: null, worktree: false };
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.update",
        requestParams,
        context,
      });
      expect(authorization.error).toBeNull();
      const respond = vi.fn();
      await sessionGroupHandlers["sessions.groups.update"]!({
        params: requestParams,
        client: viewer,
        context,
        respond,
        sessionMutationAuthorization: authorization.authorization,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        { ok: true, defaults: [{ name: "Shared", worktree: false }] },
        undefined,
      );
      expect(listSessionGroupDefaults("alpha")).toEqual([
        { name: "Shared", cwd: "/repos/alpha", worktree: true },
      ]);
      expect(
        loadSessionEntry({ agentId: "alpha", sessionKey: "agent:alpha:restricted" })?.category,
      ).toBe("Shared");
    });
  });

  it("authorizes an append without treating omitted restricted groups as removals", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await migrateDoctorSessionGroups({});
      const cfg = rolePolicyConfig();
      putSessionGroups({ cfg, agentId: "main", names: ["Restricted"] });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:restricted-append" },
        {
          sessionId: "restricted-append",
          updatedAt: 1,
          category: "Restricted",
          visibility: "read-only",
          createdActor: { type: "human", source: "profile", id: "owner@example.com" },
        },
      );
      const viewer = roleClient("none", "append-viewer");
      const context = {
        getRuntimeConfig: () => cfg,
        getSessionEventSubscriberConnIds: () => new Set<string>(),
      } as unknown as GatewayRequestContext;
      const params = { agentId: "main", names: ["New"], append: true };
      const authorization = resolveSessionMutationAuthorization({
        client: viewer,
        method: "sessions.groups.put",
        requestParams: params,
        context,
      });
      expect(authorization.error).toBeNull();
      const respond = vi.fn();
      await sessionGroupHandlers["sessions.groups.put"]!({
        params,
        client: viewer,
        context,
        respond,
        sessionMutationAuthorization: authorization.authorization,
      } as never);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          ok: true,
          groups: [
            { name: "Restricted", position: 0 },
            { name: "New", position: 1 },
          ],
          sectionOrder: [],
        },
        undefined,
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:restricted-append" })?.category,
      ).toBe("Restricted");
    });
  });
  it.each(["deletion", "recreated-same-id", "stale-workspace"] as const)(
    "rejects a defaults update after %s during real workspace resolution",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        let cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: {
              alpha: { workspace: state.path("alpha-workspace") },
              beta: { workspace: state.workspaceDir },
            },
          },
        };
        await migrateDoctorSessionGroups(cfg);
        for (const agentId of ["alpha", "beta"]) {
          putSessionGroups({ cfg, agentId, names: ["Shared"] });
          updateSessionGroupDefaults(agentId, "Shared", {
            cwd: "/repos/" + agentId,
            worktree: false,
          });
        }
        recordAgentProvenance("beta", { createdVia: "operator" }, { nowMs: 1 });
        const before = listSessionGroupDefaults("beta");
        const original = workspaceContainment.resolveWorkspacePathContainment;
        const entered = createDeferred<Awaited<ReturnType<typeof original>>>();
        const release = createDeferred();
        const containment = vi
          .spyOn(workspaceContainment, "resolveWorkspacePathContainment")
          .mockImplementation(async (...args) => {
            const resolved = await original(...args);
            entered.resolve(resolved);
            await release.promise;
            return resolved;
          });
        const respond = vi.fn();
        const context = {
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set<string>(),
        } as unknown as GatewayRequestContext;
        const pending = sessionGroupHandlers["sessions.groups.update"]!({
          params: { agentId: "beta", name: "Shared", cwd: state.workspaceDir, worktree: true },
          client: client({ user: "viewer@example.com" }),
          context,
          respond,
        } as never);
        try {
          expect(await entered.promise).not.toBeNull();
          if (change === "deletion") {
            await withAgentDeletion("beta", async (begin) => {
              const deletion = begin({
                agentId: "beta",
                agentDir: state.agentDir("beta"),
                workspaceDir: state.workspaceDir,
                sessionsDir: state.sessionsDir("beta"),
              });
              try {
                release.resolve(undefined);
                await expect(pending).rejects.toBeInstanceOf(
                  SessionMutationAuthorizationChangedError,
                );
              } finally {
                deletion.rollback();
              }
            });
          } else if (change === "recreated-same-id") {
            // The roster and id are unchanged, but the durable lifecycle owner is new.
            recordAgentProvenance("beta", { createdVia: "operator" }, { nowMs: 2 });
            release.resolve(undefined);
            await expect(pending).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
          } else {
            cfg = {
              agents: {
                ownership: "explicit",
                entries: {
                  alpha: { workspace: state.path("alpha-workspace") },
                  beta: { workspace: state.path("replacement-workspace") },
                },
              },
            };
            release.resolve(undefined);
            await pending;
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
            );
          }
          if (change !== "stale-workspace") {
            expect(respond).not.toHaveBeenCalled();
          }
          expect(listSessionGroupDefaults("beta")).toEqual(before);
          expect(listSessionGroupDefaults("alpha")).toEqual([
            { name: "Shared", cwd: "/repos/alpha", worktree: false },
          ]);
        } finally {
          release.resolve(undefined);
          await Promise.resolve(pending).catch(() => undefined);
          containment.mockRestore();
        }
      });
    },
  );
});
