import { expect, it, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { ensureProfileForEmail, setDisplayName } from "../../state/user-profiles.js";
import { createMentionInbox } from "../mention-inbox.js";
import { dispatchInboundMessageMock } from "../test-helpers.js";
import type { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

export function createPendingMentionFixture(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  return async function createMentionFixture(
    options: { active?: boolean; preserveContent?: boolean } = {},
  ) {
    const fixture = await createBrowserFollowupFixture({ preserveContent: true, ...options });
    const profiles = ["Alice", "Bob", "Carol"].map((name) => {
      const profile = ensureProfileForEmail(`${name.toLowerCase()}@mentions.example.test`);
      setDisplayName(profile.id, name);
      return { profileId: profile.id, displayName: name, hasAvatar: false, updatedAt: 1 };
    });
    const [alice, bob, carol] = profiles;
    if (!alice || !bob || !carol) {
      throw new Error("Mention test profiles were not created");
    }
    fixture.client.authenticatedUserProfile = alice;
    const bobClient = { ...fixture.client, connId: "bob-one", authenticatedUserProfile: bob };
    const carolClient = { ...fixture.client, connId: "carol", authenticatedUserProfile: carol };
    const inbox = createMentionInbox({
      gatewayInstanceId: "chat-mention-commit-test",
      getRuntimeConfig,
      getClients: () => [fixture.client, bobClient, carolClient],
      broadcastToConnIds: vi.fn(),
    });
    fixture.context.mentionInbox = inbox;
    fixture.params.message = "@Bob could you review this?";
    fixture.params.mentions = [{ profileId: bob.profileId, start: 0, end: 4 }];
    const read = (client: GatewayClient = bobClient) => {
      const result = inbox.list(client);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value.items;
    };
    return {
      ...fixture,
      bobClient,
      carolClient,
      inbox,
      read,
      cleanup: async () => {
        inbox.dispose();
        await fixture.cleanup();
      },
    };
  };
}

/** Register mention admission cases within the existing pending-input harness and lifecycle. */
export function registerChatSendPendingMentionTests(
  createBrowserFollowupFixture: ReturnType<typeof useBrowserFollowupFixture>,
) {
  const createMentionFixture = createPendingMentionFixture(createBrowserFollowupFixture);

  it.each([false, true])(
    "commits an explicit everyone snapshot once (queued: %s)",
    async (active) => {
      const fixture = await createMentionFixture({ active });
      fixture.params.message = "@everyone @Bob review this";
      fixture.params.mentions = [
        { kind: "everyone", start: 0, end: 9 },
        { profileId: fixture.bobClient.authenticatedUserProfile.profileId, start: 10, end: 14 },
      ];
      const offline = ensureProfileForEmail("offline-broadcast@mentions.example.test");
      const offlineClient = {
        ...fixture.bobClient,
        connId: "offline-broadcast",
        authenticatedUserProfile: {
          profileId: offline.id,
          displayName: "Offline",
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      try {
        const ack = await fixture.send(vi.fn<RespondFn>(), {
          expectedProfileId: fixture.client.authenticatedUserProfile!.profileId,
        });
        expect(ack).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "started" }),
          undefined,
          expect.anything(),
        );
        if (active) {
          expect(fixture.read()).toEqual([]);
        }
        const late = ensureProfileForEmail("late-broadcast@mentions.example.test");
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(fixture.read()).toHaveLength(1);
        expect(fixture.read(fixture.carolClient)).toHaveLength(1);
        expect(fixture.read(offlineClient)).toHaveLength(1);
        expect(fixture.read(fixture.client)).toEqual([]);
        const stored = JSON.stringify(committed?.message ?? recorder.getPersistedMessage?.());
        expect(stored).not.toContain(offline.id);
        expect(stored).not.toContain(late.id);
        expect(stored).not.toContain("everyoneMentionProfileIds");
        const id = fixture.read()[0]!.id;
        fixture.inbox.dismiss(fixture.bobClient, [id]);
        await fixture.send();
        await recorder.persistApproved();
        expect(fixture.read()).toEqual([]);
        expect(
          fixture.read({
            ...offlineClient,
            authenticatedUserProfile: {
              ...offlineClient.authenticatedUserProfile,
              profileId: late.id,
            },
          }),
        ).toEqual([]);
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each(["empty", "oversized", "truncated", "unavailable"] as const)(
    "recovers the accepted everyone audience when the current roster is %s",
    async (roster) => {
      const fixture = await createMentionFixture();
      const resumedRelease = createDeferred();
      const resumedReady = createDeferred<UserTurnTranscriptRecorder>();
      fixture.params.message = "@everyone review this";
      fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
      try {
        expect((await fixture.send()).mock.calls[0]?.[0]).toBe(true);
        const originalRecorder = await fixture.dispatchedRecorder;
        const rejectFreshRoster = (inbox: typeof fixture.inbox) => {
          const failure = {
            ok: false as const,
            error: errorShape(
              roster === "unavailable" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
              `Current everyone roster is ${roster}`,
            ),
          };
          return roster === "unavailable"
            ? vi.spyOn(inbox, "prepareEveryoneRecipients").mockResolvedValue(failure)
            : vi.spyOn(inbox, "resolveEveryoneRecipients").mockReturnValue(failure);
        };
        const binding = { expectedProfileId: fixture.client.authenticatedUserProfile!.profileId };
        const rosterRead = rejectFreshRoster(fixture.inbox);
        if (roster === "unavailable") {
          const wrongSender = await fixture.send(vi.fn<RespondFn>(), {
            expectedProfileId: fixture.bobClient.authenticatedUserProfile.profileId,
          });
          expect(wrongSender.mock.calls[0]?.[2]?.details).toMatchObject({
            reason: "EXPECTED_PROFILE_MISMATCH",
          });
          const entry = loadSessionEntry(fixture.scope)!;
          const scopes = fixture.client.connect.scopes;
          fixture.client.connect.scopes = ["operator.read", "operator.write"];
          replaceSessionEntrySync(fixture.scope, {
            ...entry,
            visibility: "draft",
            createdActor: {
              type: "human",
              source: "profile",
              id: fixture.bobClient.authenticatedUserProfile.profileId,
            },
          });
          const forbiddenSession = await fixture.send(vi.fn<RespondFn>(), binding);
          expect(forbiddenSession.mock.calls[0]?.[0]).toBe(false);
          replaceSessionEntrySync(fixture.scope, entry);
          fixture.client.connect.scopes = scopes;
        }
        // An accepted same-ID retry must not expand or validate a new broadcast audience.
        expect((await fixture.send(vi.fn<RespondFn>(), binding)).mock.calls[0]?.[0]).toBe(true);
        fixture.params.message += " changed";
        const conflict = await fixture.send(vi.fn<RespondFn>(), binding);
        expect(conflict.mock.calls[0]?.[2]?.details).toMatchObject({
          reason: "chat-request-conflict",
        });
        fixture.params.message = "@everyone review this";
        expect(rosterRead).not.toHaveBeenCalled();
        const original = listSessionPendingInputs(fixture.scope).items[0];
        expect(original).toBeDefined();
        const pendingJson = JSON.stringify(original);
        expect(pendingJson).not.toContain(fixture.bobClient.authenticatedUserProfile.profileId);
        expect(pendingJson).not.toContain(fixture.carolClient.authenticatedUserProfile.profileId);
        rotateAgentEventLifecycleGeneration();
        await fixture.finishDispatch();
        fixture.context.dedupe.clear();
        await patchSessionEntryCore(fixture.scope, () => ({ status: "done" }));
        const originalClock = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(originalClock + 8 * 24 * 60 * 60_000);
        fixture.inbox.dispose();
        const reopened = createMentionInbox({
          gatewayInstanceId: "restarted-private-audience",
          getRuntimeConfig,
          getClients: () => [fixture.client, fixture.bobClient, fixture.carolClient],
          broadcastToConnIds: vi.fn(),
        });
        fixture.context.mentionInbox = reopened;
        const reopenedRosterRead = rejectFreshRoster(reopened);
        const late = ensureProfileForEmail("late-after-restart@example.test");
        dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
          const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
          const recorder = replyOptions?.userTurnTranscriptRecorder;
          if (!recorder) {
            throw new Error("Expected the recovered user-turn recorder");
          }
          resumedReady.resolve(recorder);
          await resumedRelease.promise;
          return {};
        });
        Object.assign(fixture.params, { __controlUiReconnectResume: true });
        expect((await fixture.send(vi.fn<RespondFn>(), binding)).mock.calls[0]?.[0]).toBe(true);
        expect(reopenedRosterRead).not.toHaveBeenCalled();
        const resumedRecorder = await resumedReady.promise;
        expect(() => originalRecorder.withPendingInput?.(() => {})).toThrow("ownership ended");
        const committed = await resumedRecorder.persistApproved();
        expect(JSON.stringify(committed?.message)).not.toContain(
          fixture.bobClient.authenticatedUserProfile.profileId,
        );
        const bob = reopened.list(fixture.bobClient);
        const lateView = reopened.list({
          ...fixture.bobClient,
          authenticatedUserProfile: {
            ...fixture.bobClient.authenticatedUserProfile,
            profileId: late.id,
          },
        });
        expect(bob.ok && bob.value.items).toHaveLength(1);
        expect(lateView.ok && lateView.value.items).toEqual([]);
        reopened.dispose();
        clock.mockRestore();
      } finally {
        vi.restoreAllMocks();
        resumedRelease.resolve();
        fixture.context.mentionInbox?.dispose();
        await fixture.cleanup();
      }
    },
  );

  it("binds a new-session broadcast to the real runtime-created incarnation", async () => {
    const fixture = await createMentionFixture({ active: false });
    const release = createDeferred();
    const committed = createDeferred();
    fixture.params.sessionKey = "agent:main:dashboard:new-everyone";
    delete fixture.params.sessionId;
    fixture.params.message = "@everyone review this";
    fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
    dispatchInboundMessageMock.mockImplementation(async (options: unknown) => {
      const { replyOptions } = options as Parameters<typeof dispatchInboundMessage>[0];
      const scope = {
        ...fixture.scope,
        sessionKey: fixture.params.sessionKey,
        sessionId: "actual-runtime-session",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: fixture.client.authenticatedUserProfile!.profileId,
        },
      });
      replyOptions?.onSessionPrepared?.(scope);
      await replyOptions?.userTurnTranscriptRecorder?.persistApproved();
      committed.resolve();
      await release.promise;
      return {};
    });
    try {
      const ack = await fixture.send(vi.fn<RespondFn>(), {
        expectedProfileId: fixture.client.authenticatedUserProfile!.profileId,
      });
      expect(ack.mock.calls[0]?.[0]).toBe(true);
      await committed.promise;
      expect(fixture.read()).toHaveLength(1);
      expect(fixture.read()[0]?.sessionKey).toBe(fixture.params.sessionKey);
      expect(fixture.read(fixture.carolClient)).toHaveLength(1);
    } finally {
      release.resolve();
      await fixture.cleanup();
    }
  });

  it("keeps typed everyone inert through the registered chat.send entrypoint", async () => {
    const fixture = await createMentionFixture({ active: false });
    fixture.params.message = "@everyone review this";
    delete fixture.params.mentions;
    try {
      await fixture.send();
      await fixture.finishDispatch();
      expect(fixture.read()).toEqual([]);
      expect(fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rechecks access at everyone commit", async () => {
    const fixture = await createMentionFixture();
    fixture.params.message = "@everyone review this";
    fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
    try {
      await fixture.send();
      const entry = loadSessionEntry(fixture.scope);
      if (!entry) {
        throw new Error("Missing fixture session");
      }
      replaceSessionEntrySync(fixture.scope, {
        ...entry,
        visibility: "draft",
        createdActor: {
          type: "human",
          source: "profile",
          id: fixture.client.authenticatedUserProfile!.profileId,
        },
      });
      const recorder = await fixture.dispatchedRecorder;
      await recorder.persistApproved();
      expect(fixture.read()).toEqual([]);
      expect(fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("creates recipient-only mentions at original message commit, never at the queued ACK", async () => {
    const fixture = await createMentionFixture();
    try {
      const ack = await fixture.send();
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.anything(),
      );
      expect(fixture.read()).toEqual([]);
      const recorder = await fixture.dispatchedRecorder;
      const committed = await recorder.persistApproved();
      expect(committed?.appended).toBe(true);
      expect(fixture.read()).toMatchObject([
        {
          messageId: committed?.messageId,
          senderProfileId: fixture.client.authenticatedUserProfile?.profileId,
          excerpt: fixture.params.message,
        },
      ]);
      expect(fixture.read(fixture.client)).toEqual([]);
      expect(fixture.read(fixture.carolClient)).toEqual([]);
      const id = fixture.read()[0]?.id;
      expect(id).toBeDefined();
      fixture.inbox.dismiss(fixture.bobClient, id ? [id] : []);
      await recorder.persistApproved();
      await fixture.send();
      expect(fixture.read()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("includes an idle first commit in the Inbox before ACK without waiting for the agent", async () => {
    const fixture = await createMentionFixture({ active: false });
    let atAck = 0;
    try {
      const ack = await fixture.send(
        vi.fn((ok) => {
          if (ok) {
            atAck = fixture.read().length;
          }
        }),
      );
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started", messageSeq: 2 }),
        undefined,
        expect.anything(),
      );
      expect(atAck).toBe(1);
      await fixture.finishDispatch();
      expect(fixture.read()).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([false, true])(
    "does not notify when approval replaces the selected token (everyone: %s)",
    async (everyone) => {
      const fixture = await createMentionFixture({ preserveContent: false });
      if (everyone) {
        fixture.params.message = "@everyone review this";
        fixture.params.mentions = [{ kind: "everyone", start: 0, end: 9 }];
      }
      try {
        await fixture.send();
        const recorder = await fixture.dispatchedRecorder;
        const committed = await recorder.persistApproved();
        expect(committed?.message.content).toBe(fixture.approvedContent);
        expect(committed?.message["__openclaw"]?.humanMentions).toBeUndefined();
        expect(committed?.message["__openclaw"]?.everyoneMentionProfileIds).toBeUndefined();
        expect(fixture.read()).toEqual([]);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("rejects changed recipients on a same-ID retry while preserving the queued original", async () => {
    const fixture = await createMentionFixture();
    try {
      await fixture.send();
      fixture.params.mentions = [
        { profileId: fixture.carolClient.authenticatedUserProfile.profileId, start: 0, end: 4 },
      ];
      const replay = await fixture.send();
      expect(replay).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringMatching(/different|conflict|reused/i) }),
      );
      const recorder = await fixture.dispatchedRecorder;
      await recorder.persistApproved();
      expect(fixture.read()).toHaveLength(1);
      expect(fixture.read(fixture.carolClient)).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
}
