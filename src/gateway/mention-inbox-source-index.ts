import type { DatabaseSync } from "node:sqlite";
import { MENTION_INBOX_MAX_ITEMS } from "../../packages/gateway-protocol/src/index.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import type { createHumanMentionPolicy } from "./human-mention-policy.js";
import {
  mentionSourceChunkKey,
  readMentionStoreSnapshot,
  writeMentionStoreChanges,
  type MentionStoreHead,
  type MentionStoreMessage,
  type MentionStoreSource,
} from "./mention-inbox-store.js";

export type StoredMention = {
  id: string;
  recipientProfileId: string;
  source: ProcessedSource;
  message: MentionStoreMessage;
};

type ProcessedSource = {
  key: string;
  sequence: number;
  expiresAt: number;
  /** Null retains consumption after dismissal, eviction, or intentional non-delivery. */
  recipients: Map<string, StoredMention | null>;
  /** Disposable family index; durable chunks retain the shipped source record shape. */
  rootKey: string;
};

/** Disposable chunk and recipient indexes, rebuilt only from the durable Inbox source owner. */
export function createMentionInboxSourceIndex(policy: ReturnType<typeof createHumanMentionPolicy>) {
  const items = new Map<string, StoredMention>();
  const itemsByProfile = new Map<string, Set<StoredMention>>();
  const processed = new Map<string, ProcessedSource>();
  const dirtySources = new Set<string>();
  let head: MentionStoreHead = { revision: -1, nextSequence: 0 };
  let profileVersion = readUserProfileVersion();
  let nextExpiryAt = Infinity;

  function createSource(key: string, sequence: number, expiresAt: number): ProcessedSource {
    return { key, sequence, expiresAt, recipients: new Map(), rootKey: key };
  }

  function synchronize(database?: DatabaseSync): boolean {
    const snapshot = readMentionStoreSnapshot(head.revision, database);
    if (!snapshot) {
      return false;
    }
    items.clear();
    itemsByProfile.clear();
    processed.clear();
    dirtySources.clear();
    nextExpiryAt = Infinity;
    for (const stored of snapshot.sources) {
      const source = createSource(stored.key, stored.sequence, stored.expiresAt);
      processed.set(source.key, source);
      nextExpiryAt = Math.min(nextExpiryAt, source.expiresAt);
      for (const [profileId, id] of stored.recipients) {
        const item: StoredMention | null =
          id && stored.message
            ? { id, recipientProfileId: profileId, source, message: stored.message }
            : null;
        source.recipients.set(profileId, item);
        if (item) {
          items.set(item.id, item);
          indexItem(item, false);
        }
      }
    }
    // Atomic admission writes contiguous deterministic children. Stop at the first missing
    // child; dismissal/alias reconciliation retain empty rows until the shared expiry.
    for (const source of processed.values()) {
      if (source.rootKey !== source.key) {
        continue;
      }
      for (let index = 1; ; index++) {
        const child = processed.get(mentionSourceChunkKey(source.key, index));
        if (!child) {
          break;
        }
        if (child.sequence !== source.sequence + index || child.expiresAt !== source.expiresAt) {
          throw new Error("Invalid mention source chunk identity");
        }
        child.rootKey = source.key;
      }
    }
    head = snapshot.head;
    // A restart or another writer may have preceded this process's profile events.
    profileVersion = -1;
    return true;
  }

  function removeItem(item: StoredMention | null | undefined): boolean {
    if (!item || !items.delete(item.id)) {
      return false;
    }
    const profileItems = itemsByProfile.get(item.recipientProfileId);
    profileItems?.delete(item);
    if (profileItems?.size === 0) {
      itemsByProfile.delete(item.recipientProfileId);
    }
    item.source.recipients.set(item.recipientProfileId, null);
    dirtySources.add(item.source.key);
    return true;
  }

  function trimItems(
    retained: ReadonlyMap<string, StoredMention> | ReadonlySet<StoredMention>,
    limit: number,
  ) {
    const oldest = retained.values();
    while (retained.size > limit) {
      removeItem(oldest.next().value);
    }
  }

  function indexItem(item: StoredMention, trim = true): void {
    const retained = itemsByProfile.get(item.recipientProfileId) ?? new Set<StoredMention>();
    retained.add(item);
    itemsByProfile.set(item.recipientProfileId, retained);
    if (trim) {
      trimItems(retained, MENTION_INBOX_MAX_ITEMS);
    }
  }

  function expireItems(now: number): boolean {
    // Retention is bounded, but scanning it on every read and delivery makes a burst quadratic.
    if (now < nextExpiryAt) {
      return false;
    }
    let changed = false;
    let next = Infinity;
    for (const [key, source] of processed) {
      if (source.expiresAt > now) {
        next = Math.min(next, source.expiresAt);
        continue;
      }
      for (const item of source.recipients.values()) {
        changed = removeItem(item) || changed;
      }
      processed.delete(key);
      dirtySources.add(key);
    }
    nextExpiryAt = next;
    return changed;
  }

  function reconcileProfiles(): void {
    const version = readUserProfileVersion();
    if (version === profileVersion) {
      return;
    }
    profileVersion = version;
    const families = new Map<string, Map<string, ProcessedSource>>();
    for (const source of processed.values()) {
      const family = families.get(source.rootKey) ?? new Map<string, ProcessedSource>();
      families.set(source.rootKey, family);
      const recipients = new Map<string, StoredMention | null>();
      for (const [profileId, item] of source.recipients) {
        const canonical = policy.readProfile(profileId)?.profileId ?? profileId;
        if (canonical !== profileId || family.has(canonical)) {
          dirtySources.add(source.key);
        }
        const previousSource = family.get(canonical);
        if (!previousSource) {
          family.set(canonical, source);
          recipients.set(canonical, item);
          if (item) {
            item.recipientProfileId = canonical;
          }
          continue;
        }
        const previousRecipients =
          previousSource === source ? recipients : previousSource.recipients;
        const previous = previousRecipients.get(canonical);
        // An acknowledgement remains acknowledged across chunks when aliases become one person.
        if (item === null && previous) {
          items.delete(previous.id);
          previousRecipients.set(canonical, null);
          dirtySources.add(previousSource.key);
        } else if (item) {
          items.delete(item.id);
        }
      }
      source.recipients = recipients;
    }
    itemsByProfile.clear();
    for (const item of items.values()) {
      // An unresolved display can mean a transient read failure, not a deleted profile.
      // Current authorization hides it; original retention still owns durable deletion.
      indexItem(item);
    }
  }

  function writeChanges(db: DatabaseSync): void {
    const changes = new Map<string, MentionStoreSource | undefined>();
    for (const key of dirtySources) {
      const source = processed.get(key);
      if (!source) {
        changes.set(key, undefined);
        continue;
      }
      const message = [...source.recipients.values()].find((item) => item !== null)?.message;
      changes.set(key, {
        key,
        sequence: source.sequence,
        expiresAt: source.expiresAt,
        recipients: [...source.recipients].map(([profileId, item]) => [
          profileId,
          item?.id ?? null,
        ]),
        ...(message ? { message } : {}),
      });
    }
    head = writeMentionStoreChanges(db, head, changes);
  }

  return {
    items,
    itemsByProfile,
    processed,
    dirtySources,
    get head() {
      return head;
    },
    get profileVersion() {
      return profileVersion;
    },
    get nextExpiryAt() {
      return nextExpiryAt;
    },
    set nextExpiryAt(value: number) {
      nextExpiryAt = value;
    },
    createSource,
    synchronize,
    removeItem,
    trimItems,
    indexItem,
    expireItems,
    reconcileProfiles,
    writeChanges,
    invalidate() {
      head = { revision: -1, nextSequence: 0 };
    },
    clear() {
      items.clear();
      itemsByProfile.clear();
      processed.clear();
    },
  };
}
