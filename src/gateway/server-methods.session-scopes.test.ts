import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import type { OperatorScope } from "./operator-scopes.js";
import { QuestionManager } from "./question-manager.js";
import {
  dispatch,
  requestContext,
  roleConfig,
} from "./server-methods.session-scopes.test-support.js";
import { createQuestionHandlers } from "./server-methods/question.js";
import { createSecretStoreWriteService } from "./server-methods/secrets.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

const OWN_KEY = "agent:main:session-organization";

describe("session read and organization scopes", () => {
  it("keeps session reads on committed policy across tentative reload and rollback", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("committed-reader@example.test");
      const other = ensureProfileForEmail("committed-other@example.test");
      const restricted = roleConfig(["operator.write"], "none");
      const candidate = roleConfig();
      let committed = restricted;
      let runtime = restricted;
      setRuntimeConfigSnapshot(runtime);
      const client = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.read"] });
      prepareGatewayRecipientProfile(client);
      const context = requestContext(
        () => runtime,
        () => committed,
      );
      const rows = [
        { name: "own", profile: owner.id, visibility: "shared", incognito: false },
        { name: "foreign", profile: other.id, visibility: "shared", incognito: false },
        { name: "own-draft", profile: owner.id, visibility: "draft", incognito: false },
        { name: "foreign-draft", profile: other.id, visibility: "draft", incognito: false },
        { name: "incognito", profile: other.id, visibility: "shared", incognito: true },
      ] as const;
      const keyFor = (name: string) => `agent:main:committed-policy-${name}`;
      for (const row of rows) {
        const key = keyFor(row.name);
        const target = { agentId: "main", sessionKey: key };
        await upsertSessionEntryCore(target, {
          sessionId: key,
          updatedAt: 1,
          visibility: row.visibility,
          ...(row.incognito ? { incognito: true } : {}),
          createdActor: { type: "human", source: "profile", id: row.profile },
        });
        if (row.name === "own" || row.name === "foreign") {
          await appendTranscriptMessage(
            { ...target, sessionId: key },
            {
              message: { role: "user", content: `Synthetic history for ${key}` },
            },
          );
        }
      }
      const assertReads = async (phase: string, foreignVisible: boolean) => {
        const keys = [keyFor("own"), keyFor("own-draft")];
        if (foreignVisible) {
          keys.push(keyFor("foreign"));
        }
        expect
          .soft(
            await dispatch({
              method: "sessions.list",
              params: { agentId: "main" },
              client,
              context,
            }),
            `${phase}: sessions.list`,
          )
          .toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({
              count: keys.length,
              sessions: expect.arrayContaining(keys.map((key) => expect.objectContaining({ key }))),
            }),
          );
        for (const name of ["own", "foreign"] as const) {
          const key = keyFor(name);
          const history = {
            messages: [
              expect.objectContaining({ role: "user", content: `Synthetic history for ${key}` }),
            ],
          };
          const preview = expect.objectContaining({
            previews: [expect.objectContaining({ key, status: "ok" })],
          });
          for (const [method, params, payload] of [
            ["sessions.get", { key }, history],
            ["sessions.preview", { keys: [key] }, preview],
            ["sessions.resolve", { key }, expect.objectContaining({ ok: true, key })],
          ] as const) {
            const response = await dispatch({ method, params, client, context });
            if (name === "own" || foreignVisible) {
              expect
                .soft(response, `${phase}: ${method} ${name}`)
                .toHaveBeenCalledExactlyOnceWith(true, payload, undefined);
            } else {
              expect
                .soft(response, `${phase}: ${method} ${name}`)
                .toHaveBeenCalledExactlyOnceWith(
                  false,
                  undefined,
                  expect.objectContaining({ code: "INVALID_REQUEST" }),
                );
            }
          }
        }
      };
      // Warm one retained projection before tentative inputs diverge from committed policy.
      await assertReads("initial", false);
      runtime = candidate;
      setRuntimeConfigSnapshot(runtime);
      await assertReads("tentative", false);
      runtime = restricted;
      setRuntimeConfigSnapshot(runtime);
      await assertReads("rollback", false);
      runtime = candidate;
      setRuntimeConfigSnapshot(runtime);
      await assertReads("tentative again", false);
      // Advancing only committed policy must affect the retained projection without manual marks.
      committed = candidate;
      await assertReads("committed", true);
    });
  });

  it("authorizes the runtime alias target while retaining committed session policy", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("routing-owner@example.test");
      const other = ensureProfileForEmail("routing-other@example.test");
      const committed: OpenClawConfig = { ...roleConfig(), session: { scope: "per-sender" } };
      let runtime = committed;
      setRuntimeConfigSnapshot(runtime);
      const client = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.write"] });
      prepareGatewayRecipientProfile(client);
      const context = requestContext(
        () => runtime,
        () => committed,
      );
      const own = { agentId: "main", sessionKey: "agent:main:main" };
      const foreign = { agentId: "main", sessionKey: "global" };
      for (const [target, profileId] of [
        [own, owner.id],
        [foreign, other.id],
      ] as const) {
        await upsertSessionEntryCore(target, {
          sessionId: `routing-${target.sessionKey}`,
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: profileId },
        });
      }
      expect(
        await dispatch({
          method: "sessions.patch",
          params: { key: "main", agentId: "main", label: "Own main" },
          client,
          context,
        }),
      ).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({ key: own.sessionKey }),
        undefined,
      );
      const before = [own, foreign].map((target) => loadSessionEntry(target));
      expect(before[0]?.label).toBe("Own main");
      runtime = { ...committed, session: { scope: "global" } };
      setRuntimeConfigSnapshot(runtime);
      // Label/pin accepts this alias without lifecycle CAS; policy and writer must select one row.
      expect(
        await dispatch({
          method: "sessions.patch",
          params: { key: "main", agentId: "main", label: "Foreign replacement", pinned: true },
          client,
          context,
        }),
      ).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          details: expect.objectContaining({
            code: "SESSION_PARTICIPATION_REQUIRED",
            sessionKey: foreign.sessionKey,
          }),
        }),
      );
      expect([own, foreign].map((target) => loadSessionEntry(target))).toEqual(before);
    });
  });

  it.each([false, true])(
    "organizes only owned rows and preserves private state (roles=%s)",
    async (roles) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const owner = ensureProfileForEmail("organization-owner@example.test");
        const other = ensureProfileForEmail("organization-other@example.test");
        const cfg = roles ? roleConfig() : {};
        setRuntimeConfigSnapshot(cfg);
        const client = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.write"] });
        const reader = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.read"] });
        prepareGatewayRecipientProfile(client);
        prepareGatewayRecipientProfile(reader);
        const context = requestContext(() => cfg);
        const rows = [
          { key: OWN_KEY, profile: owner.id, visibility: "shared" },
          { key: "agent:main:owned-draft", profile: owner.id, visibility: "draft" },
          { key: "agent:main:foreign-shared", profile: other.id, visibility: "shared" },
          { key: "agent:main:foreign-draft", profile: other.id, visibility: "draft" },
        ] as const;
        for (const row of rows) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: row.key },
            {
              sessionId: row.key,
              updatedAt: Date.now(),
              visibility: row.visibility,
              createdActor: { type: "human", source: "profile", id: row.profile },
            },
          );
        }
        addSessionMember(
          { agentId: "main", sessionKey: rows[2].key },
          {
            identityId: owner.id,
            addedBy: other.id,
            expectedSessionId: rows[2].key,
          },
        );
        const foreignPresentation = await dispatch({
          method: "sessions.describe",
          params: { key: rows[2].key },
          client,
          context,
        });
        expect(foreignPresentation).toHaveBeenCalledExactlyOnceWith(true, {
          session: expect.objectContaining({ key: rows[2].key, sharingRole: "member" }),
        });
        for (const row of rows) {
          const read = await dispatch({
            method: "sessions.describe",
            params: { key: row.key },
            client: reader,
            context,
          });
          expect(read, row.key).toHaveBeenCalledExactlyOnceWith(true, {
            session:
              row.visibility === "draft" && row.profile !== owner.id
                ? null
                : expect.objectContaining({ key: row.key }),
          });
        }
        const ownTargets = rows.slice(0, 2).map(({ key }) => ({ key, expectedSessionId: key }));
        expect(
          await dispatch({
            method: "sessions.patch",
            params: { ...ownTargets[0], label: "My label", pinned: true },
            client,
            context,
          }),
        ).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(loadSessionEntry({ agentId: "main", sessionKey: OWN_KEY })).toMatchObject({
          label: "My label",
          pinnedAt: expect.any(Number),
        });
        const foreignBefore = loadSessionEntry({ agentId: "main", sessionKey: rows[2].key });
        for (const [method, params] of [
          ["sessions.patch", { key: rows[2].key, label: "Not mine" }],
          ["sessions.patchMany", { targets: [{ key: rows[2].key }], patch: { archived: true } }],
          ["sessions.patch", { key: "agent:main:not-created", label: "Cannot create" }],
        ] as const) {
          const denied = await dispatch({ method, params, client, context });
          expect(denied).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
        }
        expect(loadSessionEntry({ agentId: "main", sessionKey: rows[2].key })).toEqual(
          foreignBefore,
        );
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: "agent:main:not-created" }),
        ).toBeUndefined();
        expect(
          await dispatch({
            method: "sessions.patch",
            params: { key: OWN_KEY, pinned: false },
            client: reader,
            context,
          }),
        ).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ code: "FORBIDDEN" }));
        const archived = await dispatch({
          method: "sessions.patchMany",
          params: { targets: ownTargets, patch: { archived: true } },
          client,
          context,
        });
        expect(archived).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
        const beforeDenied = ownTargets.map(({ key }) =>
          loadSessionEntry({ agentId: "main", sessionKey: key }),
        );
        for (const row of beforeDenied) {
          expect(row?.archivedAt).toEqual(expect.any(Number));
        }
        for (const [method, params] of [
          ["sessions.delete", { ...ownTargets[0], archivedOnly: true }],
          ["session.visibility.set", { sessionKey: OWN_KEY, visibility: "draft" }],
          ["sessions.patch", { ...ownTargets[0], visibility: "shared" }],
          ["sessions.patchMany", { targets: ownTargets, patch: { visibility: "shared" } }],
        ] as const) {
          expect(await dispatch({ method, params, client, context })).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
        }
        expect(
          ownTargets.map(({ key }) => loadSessionEntry({ agentId: "main", sessionKey: key })),
        ).toEqual(beforeDenied);
        for (const [index, target] of ownTargets.entries()) {
          const restored = await dispatch({
            method: index === 0 ? "sessions.patch" : "sessions.patchMany",
            params:
              index === 0
                ? { ...target, archived: false }
                : { targets: [target], patch: { archived: false } },
            client,
            context,
          });
          expect(restored).toHaveBeenCalledExactlyOnceWith(true, expect.anything(), undefined);
          expect(loadSessionEntry({ agentId: "main", sessionKey: target.key })).toMatchObject({
            sessionId: target.expectedSessionId,
            visibility: rows[index]!.visibility,
          });
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: target.key })?.archivedAt,
          ).toBeUndefined();
        }
        const staff = sharingPolicyClient({ user: owner.id, scopes: ["operator.write"] });
        prepareGatewayRecipientProfile(staff);
        expect(
          await dispatch({
            method: "sessions.patch",
            params: { key: rows[2].key, label: "Staff edit" },
            client: staff,
            context,
          }),
        ).toHaveBeenCalledWith(true, expect.anything(), undefined);
      });
    },
  );

  it("adding an organization grant preserves shared membership and question participation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("mixed-grants-owner@example.test");
      const member = ensureProfileForEmail("mixed-grants-member@example.test");
      const scopes: OperatorScope[] = [
        "operator.read",
        "operator.questions",
        "operator.approvals",
        "operator.talk",
      ];
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "collaborator",
            definitions: {
              collaborator: {
                sessions: { others: "view" },
                agents: ["main"],
                scopes: [...scopes, "operator.sessions.write"],
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:mixed-grants";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "mixed-grants-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: owner.id },
        },
      );
      addSessionMember(
        { agentId: "main", sessionKey },
        { identityId: member.id, addedBy: owner.id, expectedSessionId: "mixed-grants-session" },
      );
      const requester = sharingPolicyClient({ user: owner.id, scopes: ["operator.questions"] });
      prepareGatewayRecipientProfile(requester);
      const manager = new QuestionManager();
      const reloadSecrets = vi.fn(async () => ({ warningCount: 0 }));
      const store = createSecretStoreWriteService({ reloadSecrets });
      using writeSecret = vi.spyOn(store, "write");
      const handlers = createQuestionHandlers(manager, store);
      const context = { ...requestContext(() => cfg), questionManager: manager };
      try {
        for (const organization of [false, true]) {
          const client = sharingPolicyClient({
            user: member.id,
            scopes: [...scopes, ...(organization ? ["operator.sessions.write"] : [])],
          });
          prepareGatewayRecipientProfile(client);
          expect
            .soft(
              await dispatch({
                method: "sessions.describe",
                params: { key: sessionKey },
                client,
                context,
              }),
            )
            .toHaveBeenCalledExactlyOnceWith(true, {
              session: expect.objectContaining({ key: sessionKey, sharingRole: "member" }),
            });
          const id = `mixed-grants-${organization}`;
          expect(
            await dispatch({
              method: "question.request",
              params: {
                id,
                agentId: "main",
                sessionKey,
                questions: [
                  {
                    questionId: "choice",
                    header: "Choice",
                    question: "Which option?",
                    options: [],
                    multiSelect: false,
                    isOther: true,
                    isSecret: false,
                  },
                ],
              },
              client: requester,
              context,
              handler: handlers["question.request"],
            }),
          ).toHaveBeenCalledExactlyOnceWith(true, expect.objectContaining({ id }), undefined);
          expect
            .soft(
              await dispatch({
                method: "question.resolve",
                params: { id, answers: { answers: { choice: ["ready"] } } },
                client,
                context,
                handler: handlers["question.resolve"],
              }),
            )
            .toHaveBeenCalledExactlyOnceWith(
              true,
              { status: "answered", answers: { answers: { choice: ["ready"] } } },
              undefined,
            );
          expect.soft(manager.get(id)).toMatchObject({ status: "answered" });
        }
        const rawAdmin = sharingPolicyClient({ user: member.id, scopes: ["operator.admin"] });
        prepareGatewayRecipientProfile(rawAdmin);
        for (const [method, requestParams] of [
          ["sessions.patch", { key: sessionKey, label: "Not the creator" }],
          ["sessions.patchMany", { targets: [{ key: sessionKey }], patch: { pinned: true } }],
        ] as const) {
          const authorization = resolveSessionMutationAuthorization({
            client: rawAdmin,
            context,
            method,
            requestParams,
          });
          expect(authorization.error).toMatchObject({
            code: "INVALID_REQUEST",
            details: { code: "SESSION_PARTICIPATION_REQUIRED", sessionKey },
          });
        }
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.label).toBeUndefined();
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.pinnedAt).toBeUndefined();
        expect(writeSecret).not.toHaveBeenCalled();
        expect(reloadSecrets).not.toHaveBeenCalled();
      } finally {
        manager.close();
      }
    });
  });

  it("keeps execution, creation, and runtime settings behind their existing scopes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("organization-floors@example.test");
      const cfg = roleConfig();
      setRuntimeConfigSnapshot(cfg);
      const client = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.write"] });
      prepareGatewayRecipientProfile(client);
      const context = requestContext(() => cfg);
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, {}));
      for (const [method, params] of [
        ["chat.send", { sessionKey: OWN_KEY, message: "Do work", idempotencyKey: "floor-chat" }],
        ["agent", { sessionKey: OWN_KEY, message: "Do work", idempotencyKey: "floor-agent" }],
        ["tools.invoke", { sessionKey: OWN_KEY, name: "exec", args: { command: "true" } }],
        ["sessions.send", { key: OWN_KEY, message: "Do work" }],
        ["sessions.steer", { key: OWN_KEY, message: "Do work" }],
        ["sessions.recover", { key: OWN_KEY }],
        ["sessions.fork", { key: OWN_KEY }],
        ["sessions.create", {}],
        ["sessions.create", { message: "Do work" }],
        ["sessions.patch", { key: OWN_KEY, model: "openai/gpt-test-a" }],
        [
          "sessions.patchMany",
          { targets: [{ key: OWN_KEY }], patch: { label: "Mixed", agentRuntime: "openclaw" } },
        ],
        ["sessions.patch", { key: OWN_KEY, permissionMode: "workspace" }],
        ["sessions.goal.update", { key: OWN_KEY, action: "resume" }],
        ["sessions.title.prepare", { key: OWN_KEY }],
        ["chat.toolTitles", { sessionKey: OWN_KEY }],
        ["sessions.github.publish", { key: OWN_KEY }],
      ] as const) {
        expect(await dispatch({ method, params, client, context, handler })).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      }
      expect(handler).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey: OWN_KEY })).toBeUndefined();
    });
  });

  it("does not publish a preference read after its original profile changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("preferences-reader@example.test");
      const other = ensureProfileForEmail("preferences-other@example.test");
      const cfg = roleConfig();
      setRuntimeConfigSnapshot(cfg);
      const client = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.read"] });
      prepareGatewayRecipientProfile(client);
      const preferences = await import("../state/user-preferences.js");
      expect(
        (await preferences.setCanonicalUserPreferences(owner.id, { "ui.accent": "#A1B2C3" }))?.ok,
      ).toBe(true);
      const read = preferences.getCanonicalUserPreferences;
      const prepared = createDeferredCore();
      const resume = createDeferredCore();
      using _ = vi
        .spyOn(preferences, "getCanonicalUserPreferences")
        .mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          prepared.resolve();
          await resume.promise;
          return result;
        });
      const request = dispatch({
        method: "users.prefs.get",
        params: {},
        client,
        context: requestContext(() => cfg),
      });
      try {
        await Promise.race([
          prepared.promise,
          request.then(() => {
            throw new Error("Preference request settled before its read owner");
          }),
        ]);
        client.authenticatedUserProfile = sharingPolicyClient({
          user: other.id,
        }).authenticatedUserProfile;
        resume.resolve();
        expect(await request).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "FORBIDDEN" }),
        );
      } finally {
        resume.resolve();
        await request.catch(() => {});
      }
    });
  });

  it.each([
    "current",
    "role",
    "tentative-role",
    "scope",
    "connection",
    "profile",
    "signal",
  ] as const)("rechecks the original %s before the real organization mutation", async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const owner = ensureProfileForEmail("organization-currentness@example.test");
      const other = ensureProfileForEmail("organization-new-profile@example.test");
      const client = sharingPolicyClient({ user: owner.id, scopes: ["operator.sessions.write"] });
      prepareGatewayRecipientProfile(client);
      let cfg = roleConfig();
      let committed = cfg;
      setRuntimeConfigSnapshot(cfg);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: OWN_KEY },
        {
          sessionId: OWN_KEY,
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: owner.id },
        },
      );
      const context = requestContext(
        () => cfg,
        () => committed,
      );
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const source = new AbortController();
      const request = dispatch({
        method: "sessions.patch",
        params: { key: OWN_KEY, label: "Accepted label" },
        client,
        context,
        signal: source.signal,
        handler: async (options) => {
          entered.resolve();
          await resume.promise;
          await sessionMutationHandlers["sessions.patch"]!(options);
        },
      });
      try {
        await Promise.race([
          entered.promise,
          request.then(() => {
            throw new Error("Organization request settled before its owner");
          }),
        ]);
        if (change === "role" || change === "tentative-role") {
          cfg = roleConfig(["operator.sessions.read"]);
          setRuntimeConfigSnapshot(cfg);
          if (change === "role") {
            committed = cfg;
          }
        } else if (change === "scope") {
          client.connect.scopes = ["operator.sessions.read"];
        } else if (change === "connection") {
          client.invalidated = true;
        } else if (change === "profile") {
          client.authenticatedUserProfile = sharingPolicyClient({
            user: other.id,
          }).authenticatedUserProfile;
        } else if (change === "signal") {
          source.abort(new Error("Organization requester ended"));
        }
        resume.resolve();
        const response = await request;
        const allowed = change === "current" || change === "tentative-role";
        expect(response.mock.calls.at(-1)?.[0]).toBe(allowed);
        if (!allowed) {
          expect(response).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: change === "signal" ? "UNAVAILABLE" : "FORBIDDEN" }),
          );
        }
        expect(loadSessionEntry({ agentId: "main", sessionKey: OWN_KEY })?.label).toBe(
          allowed ? "Accepted label" : undefined,
        );
      } finally {
        resume.resolve();
        await request.catch(() => {});
      }
    });
  });
});
