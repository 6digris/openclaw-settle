import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as sessionEntryLists from "../../config/sessions/session-accessor.sqlite-entry.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import { linkEmail } from "../../state/user-profiles.js";
import { rows, withCatalog } from "./session-catalog-privacy.test-support.js";
import type { RespondFn } from "./types.js";

describe("catalog delivery uses current canonical privacy", () => {
  it("keeps cold reads through the last pending follower without progress", async () => {
    await withCatalog(async ({ startCall, closeStore, enumerate, list, owner }) => {
      await closeStore();
      const release = createDeferredCore();
      const order: string[] = [];
      const observe =
        (caller: string): RespondFn =>
        (ok) => {
          expect(ok).toBe(true);
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
          order.push(caller);
        };
      list.mockImplementation(async ({ sessionEntries }) => {
        const host = enumerate(sessionEntries);
        await release.promise;
        return [host];
      });
      const leader = startCall("sessions.catalog.list", {}, owner, {
        onResponse: observe("leader"),
      });
      let follower: ReturnType<typeof startCall> | undefined;
      try {
        await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
        follower = startCall("sessions.catalog.list", {}, owner, {
          onResponse: observe("follower"),
        });
        release.resolve();
        await Promise.all([leader.completion, follower.completion]);
        expect(order).toEqual(["leader", "follower"]);
        expect(rows(leader.respond)).toEqual(["foreign", "owned"]);
        expect(rows(follower.respond)).toEqual(["foreign", "owned"]);
        expect(list).toHaveBeenCalledOnce();
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      } finally {
        release.resolve();
        await Promise.allSettled([leader.completion, follower?.completion]);
      }
    });
  });

  it("retains cold reads through the last late publication and refreshes its visibility", async () => {
    await withCatalog(
      async ({ call, broadcast, closeStore, changeForeign, enumerate, list, owner }) => {
        await closeStore();
        const release = createDeferredCore();
        let publication: Promise<void> | undefined;
        list.mockImplementation(async ({ sessionEntries, onHost, waitUntil }) => {
          const host = enumerate(sessionEntries);
          publication = release.promise.then(() => onHost?.(host));
          waitUntil?.(publication);
          return [host];
        });
        broadcast.mockImplementation(() => {
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
        });
        try {
          const response = await call("sessions.catalog.list", { progressId: "late" }, owner);
          expect(rows(response)).toEqual(["foreign", "owned"]);
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
          await changeForeign({ visibility: "draft" });
          release.resolve();
          await publication;
          expect(broadcast).toHaveBeenCalledOnce();
          expect(broadcast.mock.calls[0]?.[1]).toMatchObject({
            catalog: { hosts: [{ sessions: [{ threadId: "owned" }] }] },
          });
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        } finally {
          release.resolve();
          await publication;
        }
      },
    );
  });

  it("keeps an admitted peer current when another follower is canceled during final projection", async () => {
    await withCatalog(async ({ startCall, closeStore, context, enumerate, list, owner }) => {
      await closeStore();
      const release = createDeferredCore();
      const leaderController = new AbortController();
      const canceledController = new AbortController();
      const healthyController = new AbortController();
      let cancelNextProjection = false;
      list.mockImplementationOnce(async ({ sessionEntries }) => {
        const host = enumerate(sessionEntries);
        await release.promise;
        return [host];
      });
      const getRuntimeConfig = context.getRuntimeConfig;
      context.getRuntimeConfig = () => {
        if (cancelNextProjection) {
          cancelNextProjection = false;
          canceledController.abort();
        }
        return getRuntimeConfig();
      };
      const leader = startCall("sessions.catalog.list", {}, owner, {
        signal: leaderController.signal,
        onResponse: () => {
          cancelNextProjection = true;
        },
      });
      const canceled = startCall("sessions.catalog.list", {}, owner, {
        signal: canceledController.signal,
      });
      const healthy = startCall("sessions.catalog.list", {}, owner, {
        signal: healthyController.signal,
      });
      const completions = [leader.completion, canceled.completion, healthy.completion];
      try {
        const outcomes = Promise.allSettled(completions);
        expect(list).toHaveBeenCalledOnce();
        release.resolve();
        const [leaderOutcome, canceledOutcome, healthyOutcome] = await outcomes;
        expect(leaderOutcome).toMatchObject({ status: "fulfilled" });
        expect(canceledOutcome).toMatchObject({
          status: "rejected",
          reason: { name: "AbortError" },
        });
        expect(healthyOutcome).toMatchObject({ status: "fulfilled" });
        expect(canceledController.signal.aborted).toBe(true);
        expect(leaderController.signal.aborted).toBe(false);
        expect(healthyController.signal.aborted).toBe(false);
        expect(canceled.respond).not.toHaveBeenCalled();
        expect(rows(leader.respond)).toEqual(["foreign", "owned"]);
        expect(rows(healthy.respond)).toEqual(["foreign", "owned"]);
        expect(list).toHaveBeenCalledOnce();
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      } finally {
        context.getRuntimeConfig = getRuntimeConfig;
        release.resolve();
        await Promise.allSettled(completions);
      }
    });
  });

  it("rejects admitted final responses when canonical close revokes their reads during projection", async () => {
    await withCatalog(async ({ call, startCall, closeStore, config, context, list, owner }) => {
      await closeStore();
      let project = false;
      let closing: ReturnType<typeof closeStore> | undefined;
      let producerSignal: AbortSignal | undefined;
      const release = createDeferredCore();
      list.mockImplementationOnce(async ({ signal }) => {
        producerSignal = signal;
        await release.promise;
        project = true;
        // No delivery rows remain to trigger a later read guard before respond.
        return [];
      });
      const getRuntimeConfig = context.getRuntimeConfig;
      context.getRuntimeConfig = () => {
        if (project && !closing) {
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
          closing = closeStore();
        }
        return config;
      };
      const pending = startCall("sessions.catalog.list", {}, owner);
      const follower = startCall("sessions.catalog.list", {}, owner);
      try {
        const outcomes = Promise.allSettled([pending.completion, follower.completion]);
        release.resolve();
        const [failure, followerFailure] = await outcomes;
        assert(failure.status === "rejected", "leader must preserve the projection failure");
        assert(
          followerFailure.status === "rejected",
          "follower must preserve the projection failure",
        );
        expect(failure.reason).toMatchObject({ name: "AbortError" });
        expect(followerFailure.reason).toBe(failure.reason);
        await closing;
        expect(pending.respond).not.toHaveBeenCalled();
        expect(follower.respond).not.toHaveBeenCalled();
        expect(producerSignal?.aborted).toBe(true);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
        context.getRuntimeConfig = getRuntimeConfig;
        expect(rows(await call())).toEqual(["foreign", "owned"]);
        expect(list).toHaveBeenCalledTimes(2);
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      } finally {
        context.getRuntimeConfig = getRuntimeConfig;
        release.resolve();
        await Promise.allSettled([pending.completion, follower.completion, closing]);
      }
    });
  });

  it("uses an ordinary current read for a settled hit started inside the leader response", async () => {
    await withCatalog(async ({ startCall, closeStore, list, owner }) => {
      await closeStore();
      let settled: ReturnType<typeof startCall> | undefined;
      const leader = startCall("sessions.catalog.list", {}, owner, {
        onResponse: () => {
          expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
          settled = startCall("sessions.catalog.list", {}, owner, {
            onResponse: (ok) => {
              expect(ok).toBe(true);
              expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
            },
          });
        },
      });
      try {
        await leader.completion;
        expect(settled).toBeDefined();
        await settled?.completion;
        expect(rows(leader.respond)).toEqual(["foreign", "owned"]);
        expect(rows(settled!.respond)).toEqual(["foreign", "owned"]);
        expect(list).toHaveBeenCalledOnce();
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      } finally {
        await Promise.allSettled([leader.completion, settled?.completion]);
      }
    });
  });

  it("lists remote publications without local stores while preserving mixed-request adoption", async () => {
    await withCatalog(async ({ call, registry, read, list, enumerate, replaceForeign }) => {
      const remoteHost: SessionCatalogHost = {
        hostId: "node:source",
        label: "Source",
        kind: "node",
        connected: true,
        sessions: [
          {
            threadId: "remote",
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          },
        ],
      };
      registry.sessionCatalogs.push({
        pluginId: "publication",
        source: import.meta.url,
        provider: {
          id: "publication",
          label: "Publication",
          audience: "session-viewers",
          list: async () => [remoteHost],
          read,
        },
      });
      const unavailable = vi
        .spyOn(sessionEntryLists, "listSqliteSessionEntriesFromDatabase")
        .mockImplementation(() => {
          throw new Error("Local adoption store unavailable");
        });
      try {
        expect(rows(await call("sessions.catalog.list", { catalogId: "publication" }))).toEqual([
          "remote",
        ]);
      } finally {
        unavailable.mockRestore();
      }

      const entered = createDeferredCore();
      const release = createDeferredCore();
      let observed: SessionCatalogHost | undefined;
      list.mockImplementation(async ({ sessionEntries }) => {
        entered.resolve();
        await release.promise;
        observed = enumerate(sessionEntries);
        return [observed];
      });
      const pending = call();
      try {
        await entered.promise;
        await replaceForeign();
      } finally {
        release.resolve();
      }
      const response = await pending;
      expect(observed?.sessions.find((session) => session.threadId === "foreign")?.sessionKey).toBe(
        "agent:main:foreign",
      );
      expect(rows(response)).toEqual(["owned"]);
      expect(response.mock.calls[0]?.[1]?.catalogs[1]?.hosts).toEqual([remoteHost]);
    });
  });

  it("materializes only delivered catalog rows while preserving full planning and fresh identity", async () => {
    await withCatalog(
      async ({ call, broadcast, callerId, enumerate, list, owner, replaceForeign }) => {
        for (let index = 0; index < 24; index++) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
            { sessionId: `unrelated-${index}`, updatedAt: 1 },
          );
        }
        type ReadPhase = "planning" | "progress" | "mutation" | "final";
        let phase: ReadPhase = "planning";
        const reads: Array<{ phase: ReadPhase; count: number }> = [];
        const original = sessionEntryLists.listSqliteSessionEntriesFromDatabase;
        const read = vi
          .spyOn(sessionEntryLists, "listSqliteSessionEntriesFromDatabase")
          .mockImplementation((...args) => {
            const result = original(...args);
            reads.push({ phase, count: result.length });
            return result;
          });
        list.mockImplementation(async ({ sessionEntries, onHost }) => {
          expect(sessionEntries?.entriesForCatalog?.()).toHaveLength(27);
          const host = enumerate(sessionEntries);
          phase = "progress";
          onHost?.(host);
          phase = "mutation";
          await replaceForeign();
          phase = "final";
          return [host];
        });
        try {
          const response = await call(
            "sessions.catalog.list",
            { progressId: "delivery-budget" },
            owner,
          );
          const progress = broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions;
          expect(broadcast).toHaveBeenCalledOnce();
          expect(progress?.map((session: { threadId: string }) => session.threadId)).toEqual([
            "foreign",
            "owned",
          ]);
          expect(
            progress?.find((session: { threadId: string }) => session.threadId === "owned"),
          ).toMatchObject({ createdActor: { id: callerId } });
          expect(rows(response)).toEqual(["owned"]);
          for (const deliveryPhase of ["progress", "final"] as const) {
            const materializedRows = reads
              .filter((observed) => observed.phase === deliveryPhase)
              .reduce((total, observed) => total + observed.count, 0);
            expect(materializedRows).toBeGreaterThan(0);
            expect(materializedRows).toBeLessThanOrEqual(3);
          }
        } finally {
          read.mockRestore();
        }
      },
    );
  });

  it.each([
    { audience: "session-viewers", others: undefined, profiled: true, visible: true },
    { audience: "session-viewers", others: undefined, profiled: false, visible: false },
    { audience: "session-viewers", others: "view", profiled: true, visible: true },
    { audience: "session-viewers", others: "suggest", profiled: true, visible: true },
    { audience: "session-viewers", others: "write", profiled: true, visible: true },
    { audience: "session-viewers", others: "none", profiled: true, visible: false },
    { audience: "session-viewers", others: "view", profiled: false, visible: false },
    { audience: undefined, others: "view", profiled: true, visible: false },
  ] as const)(
    "gates native $audience rows and reads for others=$others, profiled=$profiled",
    async ({ audience, others, profiled, visible }) =>
      withCatalog(async ({ call, broadcast, config, provider, owner, host, list, read }) => {
        provider.audience = audience;
        if (others === undefined) {
          delete config.gateway!.roles;
        } else {
          config.gateway!.roles!.definitions.writer!.sessions!.others = others;
        }
        const requestClient = profiled ? owner : { ...owner, authenticatedUserProfile: undefined };
        const publishedHost: SessionCatalogHost = {
          ...host,
          sessions: [
            {
              threadId: "published-native",
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
              createdActor: {
                type: "human",
                id: "remote-human",
                label: "Published Person",
                identity: {
                  type: "remote",
                  pluginId: "fixture",
                  domain: "source",
                  idKind: "profile",
                  id: "remote-human",
                },
              },
            },
          ],
        };
        list.mockImplementation(async ({ onHost }) => {
          onHost?.(publishedHost);
          return [publishedHost];
        });
        const listed = await call(
          "sessions.catalog.list",
          { progressId: "published" },
          requestClient,
        );
        const expectedRows = visible ? publishedHost.sessions : [];
        expect
          .soft(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions)
          .toEqual(expectedRows);
        expect.soft(broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions).toEqual(expectedRows);
        const transcript = await call(
          "sessions.catalog.read",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: "published-native",
          },
          requestClient,
        );
        if (visible) {
          expect(transcript).toHaveBeenCalledWith(true, {
            hostId: host.hostId,
            threadId: "published-native",
            items: [],
          });
        } else {
          expect(transcript).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
          );
          expect(read).not.toHaveBeenCalled();
        }
      }),
  );

  it("keeps adopted catalogs owner-only on multi-identity gateways without roles", async () => {
    await withCatalog(async ({ call, config, host, read }) => {
      delete config.gateway!.roles;
      expect(rows(await call())).toEqual(["owned"]);
      const locator = { catalogId: "fixture", hostId: host.hostId };
      expect(
        await call("sessions.catalog.read", { ...locator, threadId: "foreign" }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(read).not.toHaveBeenCalled();
      const owned = await call("sessions.catalog.read", { ...locator, threadId: "owned" });
      expect(owned.mock.calls[0]?.[0]).toBe(true);
    });
  });

  it("rechecks published visibility on cached delivery after a role cap changes", async () => {
    await withCatalog(async ({ call, config, provider, host, list }) => {
      provider.audience = "session-viewers";
      list.mockResolvedValue([
        {
          ...host,
          sessions: [
            {
              threadId: "published-native",
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        },
      ]);
      const role = config.gateway!.roles!.definitions.writer!;
      role.sessions!.others = "view";
      expect(rows(await call())).toEqual(["published-native"]);
      role.sessions!.others = "none";
      expect(rows(await call())).toEqual([]);
      role.sessions!.others = "view";
      expect(rows(await call())).toEqual(["published-native"]);
      expect(list).toHaveBeenCalledTimes(2);
      delete config.gateway!.roles;
      expect(rows(await call())).toEqual(["published-native"]);
      expect(list).toHaveBeenCalledTimes(3);
    });
  });

  it("rechecks published read visibility after a role cap changes during provider read", async () => {
    await withCatalog(async ({ call, config, provider, host, read }) => {
      provider.audience = "session-viewers";
      const role = config.gateway!.roles!.definitions.writer!;
      role.sessions!.others = "view";
      const entered = createDeferredCore();
      const release = createDeferredCore();
      read.mockImplementation(async ({ hostId, threadId }) => {
        entered.resolve();
        await release.promise;
        return {
          hostId,
          threadId,
          items: [{ type: "userMessage", text: "published transcript" }],
        };
      });
      const pending = call("sessions.catalog.read", {
        catalogId: "fixture",
        hostId: host.hostId,
        threadId: "published-native",
      });
      await entered.promise;
      role.sessions!.others = "none";
      release.resolve();
      const denied = await pending;
      expect(denied).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          message: "session catalog thread is not visible to this caller",
        }),
      );
    });
  });

  it("never adopts a published source key or grants mutation authority through it", async () => {
    await withCatalog(async ({ call, provider, host, list, continueSession, archive }) => {
      provider.audience = "session-viewers";
      const createdActor = { type: "agent" as const, id: "publisher", label: "Source Agent" };
      list.mockResolvedValue([
        {
          ...host,
          sessions: [
            {
              threadId: "published-native",
              sessionKey: "agent:main:owned",
              createdActor,
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        },
      ]);
      const listed = await call();
      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        {
          threadId: "published-native",
          createdActor,
          status: "stored",
          archived: false,
          canContinue: false,
          canArchive: false,
        },
      ]);
      for (const method of ["sessions.catalog.continue", "sessions.catalog.archive"] as const) {
        const result = await call(method, {
          catalogId: "fixture",
          hostId: host.hostId,
          threadId: "published-native",
          ...(method === "sessions.catalog.archive" ? { confirmNoOtherRunner: true } : {}),
        });
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
        );
      }
      expect(continueSession).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    });
  });

  it("keeps caller-bound provider enumeration separate while sharing the same caller's work", async () => {
    await withCatalog(async ({ call, owner, foreignOwner, host, list }) => {
      const release = createDeferredCore();
      list.mockImplementation(async () => {
        const scoped = getPluginRuntimeGatewayRequestScope()?.client;
        await release.promise;
        return [{ ...host, label: scoped?.connId ?? "missing-scope", sessions: [] }];
      });
      const otherConnection = { ...owner, connId: "other-connection" };
      const admin = {
        ...owner,
        connId: "admin-connection",
        connect: { ...owner.connect, scopes: ["operator.admin"] },
      };
      const callers = [owner, owner, otherConnection, foreignOwner, admin];
      const pending = callers.map((caller) => call("sessions.catalog.list", {}, caller));
      release.resolve();
      const responses = await Promise.all(pending);
      responses.forEach((respond, index) => {
        expect
          .soft(respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.label)
          .toBe(callers[index]?.connId);
      });
      expect.soft(list).toHaveBeenCalledTimes(4);
      await call();
      expect.soft(list).toHaveBeenCalledTimes(4);
      owner.connect.scopes = ["operator.read"];
      await call();
      expect(list).toHaveBeenCalledTimes(5);
    });
  });

  it.each([{ visibility: "draft" as const }, { incognito: true as const }])(
    "rechecks settled provider results after privacy changes to %j",
    async (patch) =>
      withCatalog(async ({ call, changeForeign, list, callerId }) => {
        expect(rows(await call())).toEqual(["foreign", "owned"]);
        await changeForeign(patch);
        expect.soft(rows(await call())).toEqual(["owned"]);
        expect(list).toHaveBeenCalledOnce();
        expect(rows(await call("sessions.catalog.list", { search: "cold" }))).toEqual(["owned"]);
        expect(list).toHaveBeenCalledTimes(2);
        linkEmail("catalog-other@example.test", callerId);
        expect(rows(await call())).toEqual(
          "visibility" in patch ? ["foreign", "owned"] : ["owned"],
        );
        expect(list).toHaveBeenCalledTimes(3);
      }),
  );

  it("does not transfer a cached native thread to a replacement session at the same key", async () => {
    await withCatalog(async ({ call, changeForeign, replaceForeign, list }) => {
      await changeForeign({ visibility: "draft" });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now");
      try {
        // Cache observations use logical time; real deletion/recreation keeps native timers.
        await clock.withImplementation(
          () => now,
          async () => {
            expect(rows(await call())).toEqual(["owned"]);
          },
        );
        await replaceForeign();
        await clock.withImplementation(
          () => now + 1,
          async () => {
            expect.soft(rows(await call())).toEqual(["owned"]);
            expect(list).toHaveBeenCalledOnce();
            expect(
              rows(await call("sessions.catalog.list", { search: "cold-replacement" })),
            ).toEqual(["owned"]);
            expect(list).toHaveBeenCalledTimes(2);
          },
        );
        await clock.withImplementation(
          () => now + 3_001,
          async () => {
            expect(rows(await call())).toEqual(["owned"]);
            expect(list).toHaveBeenCalledTimes(3);
          },
        );
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("rechecks recorded plugin ownership without discarding same-instance cache work", async () => {
    await withCatalog(async ({ call, list }) => {
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      const scope = { agentId: "main", sessionKey: "agent:main:owned" };
      await upsertSessionEntryCore(scope, { pluginOwnerId: "other-plugin" });
      expect(rows(await call())).toEqual(["foreign"]);
      await upsertSessionEntryCore(scope, { pluginOwnerId: "fixture" });
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      expect(list).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { prefetch: true, late: false },
    { prefetch: false, late: false },
    { prefetch: true, late: true },
  ])(
    "retains the original adoption across replacement (prefetch=$prefetch, late=$late)",
    async ({ prefetch, late }) =>
      withCatalog(
        async ({ call, broadcast, changeForeign, replaceForeign, enumerate, list, owner }) => {
          await changeForeign({ visibility: "draft" });
          const entered = createDeferredCore();
          const release = createDeferredCore();
          let observed: SessionCatalogHost | undefined;
          let publication: Promise<void> | undefined;
          list.mockImplementation(async ({ sessionEntries, onHost, waitUntil }) => {
            if (late) {
              const prepared = enumerate(sessionEntries);
              observed = prepared;
              publication = release.promise.then(() => onHost?.(prepared));
              waitUntil?.(publication);
              entered.resolve();
              return [];
            }
            if (prefetch) {
              observed = enumerate(sessionEntries);
            }
            entered.resolve();
            await release.promise;
            observed ??= enumerate(sessionEntries);
            onHost?.(observed);
            return [observed];
          });
          const pending = call("sessions.catalog.list", { progressId: "replacement" }, owner);
          try {
            await entered.promise;
            if (late) {
              const initial = await pending;
              expect(initial.mock.calls[0]?.[1]?.catalogs[0]?.hosts).toEqual([]);
            }
            await replaceForeign();
            release.resolve();
            const result = await pending;
            await publication;
            // The provider's request snapshot keeps the original adoption even when first read
            // after its await; publication must reject that now-replaced instance independently.
            expect
              .soft(
                observed?.sessions.find((session) => session.threadId === "foreign")?.sessionKey,
              )
              .toBe("agent:main:foreign");
            if (!late) {
              expect.soft(rows(result)).toEqual(["owned"]);
            }
            expect(broadcast).toHaveBeenCalledOnce();
            expect
              .soft(
                broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions.map(
                  (session: { threadId: string }) => session.threadId,
                ),
              )
              .toEqual(["owned"]);
          } finally {
            release.resolve();
            await Promise.allSettled([pending, publication]);
          }
        },
      ),
  );

  it("rechecks each follower at progress and final delivery after provider awaits", async () => {
    await withCatalog(
      async ({ call, broadcast, changeForeign, owner, foreignOwner, host, list }) => {
        const entered = createDeferredCore();
        const progress = createDeferredCore();
        const finish = createDeferredCore();
        list.mockImplementation(async ({ sessionEntries, onHost }) => {
          sessionEntries?.entriesForCatalog?.();
          entered.resolve();
          await progress.promise;
          onHost?.(host);
          await finish.promise;
          return [host];
        });
        const leader = call("sessions.catalog.list", { progressId: "leader" }, owner);
        await entered.promise;
        const sameCaller = call("sessions.catalog.list", { progressId: "same-caller" }, owner);
        const follower = call("sessions.catalog.list", { progressId: "follower" }, foreignOwner);
        await changeForeign({ visibility: "draft" });
        progress.resolve();
        await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(3));
        const publicationFor = (progressId: string) =>
          broadcast.mock.calls.find(([, frame]) => frame.progressId === progressId);
        const progressRows = (progressId: string) =>
          publicationFor(progressId)?.[1]?.catalog.hosts[0]?.sessions.map(
            (row: { threadId: string }) => row.threadId,
          );
        expect.soft(progressRows("leader")).toEqual(["owned"]);
        expect.soft(progressRows("follower")).toEqual(["foreign"]);
        expect.soft(progressRows("same-caller")).toEqual(["owned"]);
        expect(publicationFor("leader")?.[2]).toEqual(new Set([owner.connId]));
        expect(publicationFor("follower")?.[2]).toEqual(new Set([foreignOwner.connId]));
        expect(publicationFor("same-caller")?.[2]).toEqual(new Set([owner.connId]));
        await changeForeign({ incognito: true });
        finish.resolve();
        const [leaderResult, followerResult, sameCallerResult] = await Promise.all([
          leader,
          follower,
          sameCaller,
        ]);
        expect.soft(rows(leaderResult)).toEqual(["owned"]);
        expect.soft(rows(followerResult)).toEqual([]);
        expect.soft(rows(sameCallerResult)).toEqual(["owned"]);
        expect(list).toHaveBeenCalledTimes(2);
      },
    );
  });

  it.each(
    (
      ["sessions.catalog.read", "sessions.catalog.continue", "sessions.catalog.archive"] as const
    ).flatMap((method) => [
      { method, change: "privacy" as const },
      { method, change: "replacement" as const },
    ]),
  )("rechecks $change after enumeration before $method dispatch", async ({ method, change }) =>
    withCatalog(
      async ({
        call,
        changeForeign,
        replaceForeign,
        enumerate,
        host,
        list,
        read,
        continueSession,
        archive,
      }) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        list.mockImplementation(async ({ sessionEntries }) => {
          const adopted = enumerate(sessionEntries);
          entered.resolve();
          await release.promise;
          return [adopted];
        });
        const locator = {
          catalogId: "fixture",
          hostId: host.hostId,
          threadId: "foreign",
          ...(method === "sessions.catalog.archive" ? { confirmNoOtherRunner: true } : {}),
        };
        const pending = call(method, locator);
        await entered.promise;
        await changeForeign({ visibility: "draft" });
        if (change === "replacement") {
          await replaceForeign();
        }
        release.resolve();
        const denied = await pending;
        expect
          .soft(denied)
          .toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
          );
        const dispatch =
          method === "sessions.catalog.read"
            ? read
            : method === "sessions.catalog.continue"
              ? continueSession
              : archive;
        expect.soft(dispatch).not.toHaveBeenCalled();
        const allowed = await call(method, { ...locator, threadId: "owned" });
        expect(allowed.mock.calls[0]?.[0]).toBe(true);
      },
    ),
  );
});
