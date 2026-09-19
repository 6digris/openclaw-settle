import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as transcriptSearch from "../../config/sessions/session-transcript-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import {
  disposeSessionReadContexts,
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";

afterEach(() => vi.restoreAllMocks());

const methods = ["sessions.search", "sessions.list", "sessions.subscribe"] as const;
type ScopeMethod = (typeof methods)[number];

function matchingSessions(method: ScopeMethod, key: string) {
  const sessions = [{ key }];
  return method === "sessions.subscribe"
    ? { list: { sessions } }
    : { ...(method === "sessions.search" ? { results: [{ sessionKey: key }] } : {}), sessions };
}

async function seedSearchSession(
  agentId: string,
  name: string,
  owner: string,
  storePath?: string,
  spawnedBy?: string,
) {
  const sessionKey = `agent:${agentId}:${name}`;
  const sessionId = `${agentId}-${name}`;
  const scope = { agentId, sessionKey, sessionId, storePath };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "human", source: "profile", id: owner },
    ...(spawnedBy ? { spawnedBy, parentSessionKey: spawnedBy } : {}),
  });
  await persistSessionTranscriptTurn(scope, {
    cwd: "/fixture",
    updateMode: "none",
    messages: [{ message: { role: "user", content: "identityneedle" }, now: 1 }],
  });
  return sessionKey;
}

async function authenticatedScopeRequest(
  cfg: OpenClawConfig,
  canonical: boolean,
  profileId: string,
  method: ScopeMethod,
) {
  setRuntimeConfigSnapshot(cfg);
  const context = requestContext(cfg);
  context.subscribeSessionEvents = vi.fn();
  await initializeSessionReadContext(context);
  const client = Object.assign(createOperatorWsClient(), identifiedClient(profileId));
  client.connect.caps = canonical ? ["canonical-session-keys"] : [];
  const harness = createDispatchTestHarness({
    buildRequestContext: () => context,
    extraHandlers: { ...sessionReadHandlers, ...sessionSubscriptionHandlers },
  });
  let requestId = 0;
  return async (scope: Record<string, unknown>) => {
    const id = `identity-search-${++requestId}`;
    await harness.dispatcher.dispatch(
      {
        type: "req",
        id,
        method,
        params: method === "sessions.search" ? { query: "identityneedle", scope } : scope,
      },
      client,
    );
    return await harness.awaitResponseFrame(id);
  };
}

describe.each([false, true])("session scope identity with canonical=%s", (canonical) => {
  it.each(methods)("rejects malformed owners before %s reaches transcripts", async (method) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      try {
        const owner = ensureProfileForEmail("identity-search@example.test").id;
        await seedSearchSession("main", "visible", owner);
        const search = await authenticatedScopeRequest(
          { agents: { entries: { main: {}, research: {} } } },
          canonical,
          owner,
          method,
        );
        const fts = vi.spyOn(transcriptSearch, "searchSessionTranscripts");
        for (const agentId of ["!!!", " ", ""]) {
          expect(await search({ agentId })).toMatchObject({
            ok: false,
            error: { code: "INVALID_REQUEST" },
          });
        }
        expect(fts).not.toHaveBeenCalled();
      } finally {
        disposeSessionReadContexts();
      }
    });
  });

  it.each(methods)(
    "resolves shared-store parents independently of the child agent in %s",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        try {
          const storePath = state.statePath("shared-search.sqlite");
          const cfg: OpenClawConfig = {
            agents: {
              ownership: "explicit",
              entries: { ops: {}, research: {} },
              defaults: { sessionStore: { agentId: "ops" } },
            },
            session: { scope: "global", store: storePath },
          };
          setRuntimeConfigSnapshot(cfg);
          const owner = ensureProfileForEmail("shared-identity-search@example.test").id;
          await seedSearchSession("ops", "global", owner, storePath);
          await seedSearchSession("research", "global", owner, storePath);
          const researchFromOps = await seedSearchSession(
            "research",
            "from-ops",
            owner,
            storePath,
            "agent:ops:global",
          );
          const opsFromResearch = await seedSearchSession(
            "ops",
            "from-research",
            owner,
            storePath,
            "agent:research:global",
          );
          const researchFromMain = await seedSearchSession(
            "research",
            "from-exact-main",
            owner,
            storePath,
            "agent:ops:main",
          );
          const search = await authenticatedScopeRequest(cfg, canonical, owner, method);
          for (const [agentId, spawnedBy, key] of [
            ["research", "global", researchFromOps],
            ["ops", "agent:research:global", opsFromResearch],
            ["research", "agent:ops:global", researchFromOps],
            ["research", "agent:ops:main", canonical ? researchFromMain : researchFromOps],
          ] as const) {
            expect(await search({ agentId, spawnedBy })).toMatchObject({
              ok: true,
              payload: matchingSessions(method, key),
            });
          }
        } finally {
          disposeSessionReadContexts();
        }
      });
    },
  );

  it.each(methods)(
    "refuses ambiguous bare parents without borrowing the child agent in %s",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        try {
          const cfg: OpenClawConfig = {
            agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
            session: { scope: "global" },
          };
          setRuntimeConfigSnapshot(cfg);
          const owner = ensureProfileForEmail("ambiguous-identity-search@example.test").id;
          await seedSearchSession("ops", "global", owner);
          await seedSearchSession("research", "global", owner);
          const key = await seedSearchSession(
            "research",
            "from-ops",
            owner,
            undefined,
            "agent:ops:global",
          );
          const search = await authenticatedScopeRequest(cfg, canonical, owner, method);
          const fts = vi.spyOn(transcriptSearch, "searchSessionTranscripts");
          expect(await search({ agentId: "research", spawnedBy: "global" })).toMatchObject({
            ok: false,
            error: { code: "INVALID_REQUEST" },
          });
          expect(fts).not.toHaveBeenCalled();
          expect(
            await search({ agentId: "research", spawnedBy: "agent:ops:global" }),
          ).toMatchObject({
            ok: true,
            payload: matchingSessions(method, key),
          });
        } finally {
          disposeSessionReadContexts();
        }
      });
    },
  );

  it("projects only typed search rows and lineage for the selected client dialect", async () => {
    const opaque = { sessionKey: "agent:research:global", key: "agent:ops:unknown" };
    const payload = {
      results: [{ sessionKey: "agent:research:global", snippet: "agent:research:global" }],
      sessions: [
        {
          key: "agent:research:global",
          agentId: "research",
          spawnedBy: "agent:research:unknown",
          parentSessionKey: "agent:ops:global",
          messages: [opaque],
          toolResult: opaque,
        },
      ],
    };
    const client = createOperatorWsClient();
    client.connect.caps = canonical ? ["canonical-session-keys"] : [];
    const harness = createDispatchTestHarness({
      extraHandlers: { "sessions.search": ({ respond }) => respond(true, payload) },
    });
    await harness.dispatcher.dispatch(
      {
        type: "req",
        id: "search-wire",
        method: "sessions.search",
        params: { query: "needle", scope: {} },
      },
      client,
    );
    expect(await harness.awaitResponseFrame("search-wire")).toMatchObject({
      ok: true,
      payload: {
        results: [
          {
            sessionKey: canonical ? "agent:research:global" : "global",
            snippet: "agent:research:global",
          },
        ],
        sessions: [
          {
            key: canonical ? "agent:research:global" : "global",
            agentId: "research",
            spawnedBy: canonical ? "agent:research:unknown" : "unknown",
            parentSessionKey: "agent:ops:global",
            messages: [opaque],
            toolResult: opaque,
          },
        ],
      },
    });
    expect(payload.sessions[0]?.key).toBe("agent:research:global");
    expect(payload.sessions[0]?.spawnedBy).toBe("agent:research:unknown");
  });
});
