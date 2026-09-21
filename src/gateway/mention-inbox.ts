import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  MAX_EVERYONE_MENTION_RECIPIENTS,
  MAX_HUMAN_MENTIONS,
  errorShape,
  type ErrorShape,
  type MentionInboxItem,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { updateSessionProfileInvolvement } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { onUserProfilesChanged, readUserProfileVersion } from "../state/user-profile-events.js";
import { createHumanMentionPolicy, humanMentionDisplayLabel } from "./human-mention-policy.js";
import {
  consumeMentionAudience,
  applyMentionAudienceCleanup,
  prepareMentionAudienceCleanup,
  nextMentionAudienceExpiry,
  readMentionAudience,
  retainMentionAudience,
} from "./mention-inbox-audience-store.js";
import { createMentionInboxSourceIndex, type StoredMention } from "./mention-inbox-source-index.js";
import {
  MAX_MENTION_SOURCES,
  MAX_MENTION_SOURCE_RECIPIENTS,
  MENTION_RETENTION_MS,
  mentionSourceChunkKey,
} from "./mention-inbox-store.js";
import type { MentionCommittedInput, MentionInbox } from "./mention-inbox.types.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveSessionSharingTarget } from "./session-sharing.js";
import { deriveSessionTitle } from "./session-utils-core.js";

const MAX_GLOBAL_ITEMS = 10_000;
const log = createSubsystemLogger("gateway/mentions");

type MentionNotification = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel: string;
  sessionTitle: string;
  isCurrent: () => boolean;
};

type SharingTargets = Map<
  string,
  { sessionKey: string; target: ReturnType<typeof resolveSessionSharingTarget> }
>;

/** Durable sources own retention and replay; each Gateway keeps disposable projection indexes. */
export function createMentionInbox(params: {
  gatewayInstanceId: string;
  getRuntimeConfig: () => OpenClawConfig;
  getClients: () => Iterable<GatewayClient>;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  onMentionCreated?: (notification: MentionNotification) => void;
}): MentionInbox {
  const policy = createHumanMentionPolicy(params);
  const sourceIndex = createMentionInboxSourceIndex(policy);
  const {
    items,
    itemsByProfile,
    processed,
    dirtySources,
    createSource,
    synchronize,
    removeItem,
    trimItems,
    indexItem,
    expireItems,
    reconcileProfiles,
  } = sourceIndex;
  const views = new WeakMap<GatewayClient, { signature: string; revision: number }>();
  const connectedTargets: SharingTargets = new Map();
  let targetConfig: OpenClawConfig | undefined;
  let active = true;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let capacityReported = false;
  let profileInvalidationPending = false;
  let audienceCleanupDeferred = false;
  // The guarded initial refresh hydrates expiry with the source index. Optional
  // Inbox storage failures must not abort Gateway construction.
  let audienceExpiryAt = Infinity;

  function mutate<T>(operation: (database: DatabaseSync) => T, cleanup = true): T {
    try {
      const audienceCleanup =
        cleanup && !audienceCleanupDeferred && Date.now() >= audienceExpiryAt
          ? prepareMentionAudienceCleanup()
          : [];
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          synchronize(db);
          const now = Date.now();
          const expiryDue = now >= sourceIndex.nextExpiryAt;
          expireItems(now);
          if (expiryDue && processed.size < MAX_MENTION_SOURCES) {
            capacityReported = false;
          }
          reconcileProfiles();
          applyMentionAudienceCleanup(db, audienceCleanup);
          const result = operation(db);
          if (!cleanup && !audienceCleanupDeferred) {
            // Synchronous push adapters can reenter reads before the next collected source.
            audienceCleanupDeferred = true;
            queueMicrotask(() => {
              audienceCleanupDeferred = false;
            });
          }
          audienceExpiryAt = nextMentionAudienceExpiry(db);
          sourceIndex.writeChanges(db);
          return result;
        },
        {},
        { operationLabel: "mentions.write" },
      );
    } catch (error) {
      // Uncommitted indexes are never published; the next read rebuilds from durable state.
      sourceIndex.invalidate();
      throw error;
    } finally {
      dirtySources.clear();
    }
  }

  function maintain(): boolean {
    const changed = synchronize();
    const maintenance =
      Date.now() >= Math.min(sourceIndex.nextExpiryAt, audienceExpiryAt) ||
      sourceIndex.profileVersion !== readUserProfileVersion();
    if (maintenance) {
      mutate(() => undefined);
    }
    return changed || maintenance;
  }

  function currentTarget(item: StoredMention, cfg: OpenClawConfig, targets?: SharingTargets) {
    const { source, message } = item;
    const { agentId, sessionKey, senderProfileId } = message.content;
    if (!active || items.get(item.id) !== item || source.expiresAt <= Date.now()) {
      return undefined;
    }
    const key = JSON.stringify([agentId, sessionKey]);
    let resolved = targets?.get(key)?.target;
    if (resolved === undefined) {
      resolved = resolveSessionSharingTarget({
        cfg,
        sessionKey,
        agentId,
      });
      if (targets?.size === MAX_GLOBAL_ITEMS) {
        targets.clear();
      }
      targets?.set(key, { sessionKey, target: resolved });
    }
    if (!resolved || resolved.entry.sessionId !== message.sessionId) {
      return undefined;
    }
    const target = {
      agentId: resolved.agentId,
      sessionKey: resolved.canonicalKey,
      entry: resolved.entry,
    };
    const recipient = policy.recipientProfile(item.recipientProfileId, target, cfg);
    const sender = policy.readProfile(senderProfileId);
    return recipient && recipient.profileId !== sender?.profileId
      ? { target, recipient, sender }
      : undefined;
  }

  function projectItem(
    item: StoredMention,
    current: NonNullable<ReturnType<typeof currentTarget>>,
  ): MentionInboxItem {
    const { content } = item.message;
    return {
      ...content,
      id: item.id,
      expiresAt: item.source.expiresAt,
      senderProfileId: current.sender?.profileId ?? content.senderProfileId,
      senderLabel: humanMentionDisplayLabel(current.sender?.label, content.senderProfileId),
      ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
      sessionTitle:
        truncateUtf16Safe(
          (deriveSessionTitle(current.target.entry) ?? "Conversation")
            .replace(/[\p{Cc}\p{Cf}]/gu, " ")
            .replace(/\s+/gu, " ")
            .trim(),
          256,
        ) || "Conversation",
    };
  }

  function readView(
    client: GatewayClient | null,
    cfg = params.getRuntimeConfig(),
    remember = true,
    targets: SharingTargets = new Map(),
  ): Result<MentionsListResult, ErrorShape> {
    const identified = policy.identify(client, cfg);
    if (!identified.ok) {
      return identified;
    }
    const requester = identified.value;
    const visible: MentionInboxItem[] = [];
    const profileItems = itemsByProfile.get(requester.profile.profileId);
    for (const item of [...(profileItems ?? [])].toReversed()) {
      const current = currentTarget(item, cfg, targets);
      if (current && requester.canRead(current.target)) {
        visible.push(projectItem(item, current));
      }
    }
    const signature = createHash("sha256")
      .update(JSON.stringify([requester.profile.profileId, visible]))
      .digest("hex");
    const previous = client && views.get(client);
    const revision = previous ? previous.revision + Number(signature !== previous.signature) : 0;
    if (client && remember) {
      views.set(client, { signature, revision });
    }
    return ok({ gatewayInstanceId: params.gatewayInstanceId, revision, items: visible });
  }

  function refreshConnectedViews(): void {
    const cfg = params.getRuntimeConfig();
    if (targetConfig !== cfg) {
      connectedTargets.clear();
      targetConfig = cfg;
    }
    for (const client of params.getClients()) {
      if (!client.connId) {
        continue;
      }
      const previous = views.get(client);
      const result = readView(client, cfg, true, connectedTargets);
      if (
        !result.ok ||
        (previous ? previous.revision === result.value.revision : result.value.items.length === 0)
      ) {
        continue;
      }
      params.broadcastToConnIds(
        "mentions.changed",
        { gatewayInstanceId: params.gatewayInstanceId, revision: result.value.revision },
        new Set([client.connId]),
      );
    }
  }

  function scheduleExpiry(retryAfterMs?: number): void {
    if (
      expiryTimer ||
      !active ||
      (processed.size === 0 && audienceExpiryAt === Infinity && retryAfterMs === undefined)
    ) {
      return;
    }
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        refresh();
      },
      retryAfterMs ??
        Math.max(1, Math.min(sourceIndex.nextExpiryAt, audienceExpiryAt) - Date.now()),
    );
    expiryTimer.unref?.();
  }

  function refresh(): void {
    if (!active) {
      return;
    }
    try {
      maintain();
      refreshConnectedViews();
      scheduleExpiry();
    } catch {
      log.warn("Unable to refresh the mention Inbox; current reads will retry.");
      // A failed expiry write must not retire cleanup while the Gateway remains alive.
      scheduleExpiry(60_000);
    }
  }

  function invalidateTargets(sessionKey?: string): void {
    if (!sessionKey) {
      connectedTargets.clear();
      return;
    }
    for (const [key, cached] of connectedTargets) {
      if (cached.sessionKey === sessionKey || cached.target?.storeKeys.includes(sessionKey)) {
        connectedTargets.delete(key);
      }
    }
  }

  function invalidate(sessionKey?: string): void {
    invalidateTargets(sessionKey);
    policy.invalidateDirectory();
    refresh();
  }

  // Only connected-view refreshes retain targets across calls. Committed row publications
  // invalidate them; direct reads and delayed push authority keep their fresh exact reads.
  const stopRows = sessionChanges.subscribe((change) =>
    invalidateTargets("sessionKey" in change ? change.sessionKey : undefined),
  );

  // Profile writes publish after commit. The microtask also follows role-policy cache invalidation.
  const stopProfiles = onUserProfilesChanged(() => {
    if (profileInvalidationPending) {
      return;
    }
    profileInvalidationPending = true;
    queueMicrotask(() => {
      profileInvalidationPending = false;
      invalidate();
    });
  });
  const stopSessions = onSessionIdentityMutation(() => invalidate());

  function unavailable(warn = false): Result<never, ErrorShape> {
    if (warn) {
      log.warn("The mention Inbox could not read or save its current state. Reconnect to retry.");
    }
    return err(
      errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
        retryable: true,
      }),
    );
  }

  function readOperation<T>(operation: () => Result<T, ErrorShape>): Result<T, ErrorShape> {
    if (active) {
      try {
        return operation();
      } catch {
        return unavailable(true);
      }
    }
    return unavailable();
  }

  refresh();

  return {
    async mentionable(client, input, publish) {
      let preparationFailure: Result<never, ErrorShape> | undefined;
      try {
        // A committed profile change can invalidate preparation before this continuation runs.
        while (policy.needsDirectoryPreparation()) {
          await policy.prepareDirectory();
        }
      } catch {
        preparationFailure = unavailable(true);
      }
      // Current policy selection and response publication must not cross another await.
      publish(preparationFailure ?? readOperation(() => policy.mentionable(client, input)));
    },
    validateRecipients: (...args: Parameters<typeof policy.validateRecipients>) =>
      readOperation(() => policy.validateRecipients(...args)),
    async prepareEveryoneRecipients() {
      try {
        while (policy.needsDirectoryPreparation()) {
          await policy.prepareDirectory();
        }
        return active ? ok(undefined) : unavailable();
      } catch {
        return unavailable(true);
      }
    },
    resolveEveryoneRecipients: (...args: Parameters<typeof policy.resolveEveryoneRecipients>) =>
      readOperation(() => policy.resolveEveryoneRecipients(...args)),
    retainEveryoneAudience(client, identity, options) {
      if (!active) {
        throw new Error("The mention Inbox is unavailable");
      }
      mutate((db) => {
        options.assertCurrent();
        const identified = policy.identify(client, params.getRuntimeConfig());
        const resolved = resolveSessionSharingTarget({
          cfg: params.getRuntimeConfig(),
          ...identity,
        });
        if (
          !identified.ok ||
          identified.value.profile.profileId !== identity.senderProfileId ||
          !resolved ||
          resolved.entry.sessionId !== identity.sessionId ||
          !identified.value.canRead({
            agentId: resolved.agentId,
            sessionKey: resolved.canonicalKey,
            entry: resolved.entry,
          }) ||
          resolved.entry.incognito ||
          isIncognitoSessionKey(resolved.canonicalKey)
        ) {
          throw new Error("Mention audience no longer owns its admitted sender and session");
        }
        // An accepted source without custody must never use a freshly expanded audience.
        const recipients = options.recovered
          ? readMentionAudience(db, identity)?.recipients
          : options.recipients;
        if (!recipients) {
          throw new Error("Mention audience custody expired or is unavailable; submit a new turn");
        }
        options.assertCurrent();
        retainMentionAudience(db, identity, recipients);
      });
      scheduleExpiry();
    },
    list(client: GatewayClient | null): Result<MentionsListResult, ErrorShape> {
      return readOperation(() => {
        if (maintain()) {
          refreshConnectedViews();
        }
        scheduleExpiry();
        return readView(client);
      });
    },
    dismiss(
      client: GatewayClient | null,
      ids: readonly string[],
    ): Result<MentionsListResult, ErrorShape> {
      return readOperation(() => {
        const result = mutate(() => {
          const current = readView(client, params.getRuntimeConfig(), false);
          if (current.ok) {
            const owned = new Set(current.value.items.map((item) => item.id));
            for (const id of ids) {
              if (owned.has(id)) {
                removeItem(items.get(id));
              }
            }
          }
          return current;
        });
        if (!result.ok) {
          return result;
        }
        refresh();
        return readView(client);
      });
    },
    recordCommittedInput(input: MentionCommittedInput): void {
      try {
        if (!active || (input.recipientProfileIds.length === 0 && !input.everyoneAudience)) {
          return;
        }
        if (
          input.recipientProfileIds.length >
          MAX_EVERYONE_MENTION_RECIPIENTS + MAX_HUMAN_MENTIONS
        ) {
          log.warn("Skipped mention delivery with invalid committed references.");
          return;
        }
        const committed = mutate<StoredMention[]>((db) => {
          const audience = input.everyoneAudience;
          const identity = audience?.identity;
          if (
            identity &&
            (identity.agentId !== input.agentId ||
              identity.sessionKey !== input.sessionKey ||
              identity.sessionId !== input.sessionId ||
              identity.sourceId !== input.sourceId ||
              identity.senderProfileId !== input.senderProfileId)
          ) {
            throw new Error("Mention audience does not match its committed source");
          }
          const receipt = identity ? readMentionAudience(db, identity) : undefined;
          if (identity) {
            consumeMentionAudience(db, identity);
          }
          if (audience?.retained && !receipt) {
            log.warn(
              "Broadcast mention skipped because its admitted audience custody is unavailable.",
            );
          }
          const selected = [
            ...input.recipientProfileIds,
            ...(audience?.retained && receipt ? receipt.recipients : []),
          ];
          // Canonicalize direct selections before applying the broadcast bound: an alias
          // selected alongside everyone still denotes only one recipient.
          const recipientProfileIds = [
            ...new Set(selected.map((id) => policy.readProfile(id)?.profileId ?? id)),
          ];
          const references = [
            input.sourceId,
            input.sessionId,
            input.messageId,
            input.senderProfileId,
            ...recipientProfileIds,
          ];
          if (
            recipientProfileIds.length > MAX_EVERYONE_MENTION_RECIPIENTS ||
            input.sessionKey.length > 512 ||
            references.some((value) => !value || value.length > 256)
          ) {
            log.warn("Skipped mention delivery with invalid committed references.");
            return [];
          }
          if (!recipientProfileIds.length) {
            return [];
          }
          const cfg = params.getRuntimeConfig();
          const resolved = resolveSessionSharingTarget({
            cfg,
            sessionKey: input.sessionKey,
            agentId: input.agentId,
          });
          if (
            !resolved ||
            resolved.entry.sessionId !== input.sessionId ||
            resolved.entry.incognito === true ||
            isIncognitoSessionKey(resolved.canonicalKey)
          ) {
            log.debug("Skipped mention delivery because its committed session changed.");
            return [];
          }
          const sourceKey = createHash("sha256")
            .update(
              JSON.stringify([
                resolved.agentId,
                resolved.canonicalKey,
                input.sessionId,
                input.sourceId,
              ]),
            )
            .digest("hex");
          if (processed.has(sourceKey)) {
            return [];
          }
          const senderProfile = policy.recipientProfile(
            input.senderProfileId,
            {
              agentId: resolved.agentId,
              sessionKey: resolved.canonicalKey,
              entry: resolved.entry,
            },
            cfg,
          );
          const mentionedProfiles = recipientProfileIds.flatMap((id) => {
            const recipient = policy.recipientProfile(
              id,
              {
                agentId: resolved.agentId,
                sessionKey: resolved.canonicalKey,
                entry: resolved.entry,
              },
              cfg,
            );
            return senderProfile && recipient && senderProfile.profileId !== recipient.profileId
              ? [recipient.profileId]
              : [];
          });
          updateSessionProfileInvolvement(
            {
              agentId: resolved.agentId,
              sessionKey: resolved.storeKey,
              storePath: resolved.storePath,
            },
            {
              expectedSessionId: input.sessionId,
              profileIds: mentionedProfiles,
              change: { kind: "mention", source: input.committedSource },
            },
          );
          // Never evict consumption early to make room: doing so could re-alert a dismissed message.
          const chunkCount = Math.ceil(recipientProfileIds.length / MAX_MENTION_SOURCE_RECIPIENTS);
          if (processed.size + chunkCount > MAX_MENTION_SOURCES) {
            if (!capacityReported) {
              log.warn(
                "Mention retention reached its replay budget; new mention alerts are skipped until retained sources expire.",
              );
              capacityReported = true;
            }
            return [];
          }
          const now = Date.now();
          // Keep the root replay key and every child in the same admission/transaction.
          // Older readers see ordinary mentions, each within their ten-recipient bound.
          const sources = Array.from({ length: chunkCount }, (_, index) => {
            const key = mentionSourceChunkKey(sourceKey, index);
            const source = createSource(
              key,
              sourceIndex.head.nextSequence++,
              now + MENTION_RETENTION_MS,
            );
            source.rootKey = sourceKey;
            processed.set(key, source);
            dirtySources.add(key);
            return source;
          });
          sourceIndex.nextExpiryAt = Math.min(sourceIndex.nextExpiryAt, sources[0]!.expiresAt);
          const sender = senderProfile;
          const target = {
            agentId: resolved.agentId,
            sessionKey: resolved.canonicalKey,
            entry: resolved.entry,
          };
          const excerpt = input.excerpt
            ? truncateUtf16Safe(
                flattenMarkdownToPlainText(truncateUtf16Safe(input.excerpt, 2_048))
                  .replace(/[\p{Cc}\p{Cf}]/gu, " ")
                  .replace(/\s+/gu, " ")
                  .trim(),
                280,
              )
            : undefined;
          // Recipients share immutable message data; consumed sources retain only replay tombstones.
          const message: StoredMention["message"] = {
            sessionId: input.sessionId,
            content: {
              senderProfileId: sender?.profileId ?? input.senderProfileId,
              sessionKey: target.sessionKey,
              agentId: target.agentId,
              messageId: input.messageId,
              createdAt: now,
              ...(excerpt ? { excerpt } : {}),
            },
          };
          const created: StoredMention[] = [];
          let unavailableRecipients = 0;
          for (const [index, profileId] of recipientProfileIds.entries()) {
            const source = sources[Math.floor(index / MAX_MENTION_SOURCE_RECIPIENTS)]!;
            const recipient = policy.recipientProfile(profileId, target, cfg);
            const canonicalId = recipient?.profileId ?? profileId;
            if (source.recipients.has(canonicalId)) {
              continue;
            }
            source.recipients.set(canonicalId, null);
            if (!sender || !recipient || sender.profileId === recipient.profileId) {
              unavailableRecipients += 1;
              continue;
            }
            const item: StoredMention = {
              id: randomUUID(),
              recipientProfileId: recipient.profileId,
              source,
              message,
            };
            items.set(item.id, item);
            source.recipients.set(recipient.profileId, item);
            indexItem(item);
            trimItems(items, MAX_GLOBAL_ITEMS);
            created.push(item);
          }
          if (unavailableRecipients > 0) {
            log.debug(
              `Skipped ${unavailableRecipients} unavailable mention recipients for committed input.`,
            );
          }
          return created;
        }, false);
        // Collected sources publish sequentially after one transaction consumes them all.
        // Do not sweep their private receipts between original-source callbacks.
        refreshConnectedViews();
        scheduleExpiry();
        if (!params.onMentionCreated) {
          return;
        }
        for (const item of committed) {
          const retained = items.get(item.id);
          const current = retained && currentTarget(retained, params.getRuntimeConfig());
          if (!retained || !current) {
            continue;
          }
          const projected = projectItem(retained, current);
          params.onMentionCreated({
            id: item.id,
            recipientProfileId: current.recipient.profileId,
            sessionKey: projected.sessionKey,
            agentId: projected.agentId,
            senderLabel: projected.senderLabel,
            sessionTitle: projected.sessionTitle,
            isCurrent: () => {
              try {
                if (!active) {
                  return false;
                }
                maintain();
                const latest = items.get(item.id);
                return Boolean(latest && currentTarget(latest, params.getRuntimeConfig()));
              } catch {
                return false;
              }
            },
          });
        }
      } catch {
        log.warn("Mention delivery could not be completed; the posted message is unchanged.");
      }
    },
    invalidate,
    dispose(): void {
      active = false;
      stopProfiles();
      stopSessions();
      stopRows();
      connectedTargets.clear();
      policy.dispose();
      if (expiryTimer) {
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
      }
      sourceIndex.clear();
    },
  };
}
