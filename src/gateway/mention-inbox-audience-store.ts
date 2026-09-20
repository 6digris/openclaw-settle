import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MAX_EVERYONE_MENTION_RECIPIENTS } from "../../packages/gateway-protocol/src/index.js";
import { hasRetainedSessionPendingInput } from "../config/sessions/session-accessor.pending-input-sources.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { ConfigMachineStateDatabase } from "../state/config-machine-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  mentionAudienceIdentitySchema,
  type MentionAudienceIdentity,
} from "./mention-inbox-audience-schema.js";
import { MAX_MENTION_SOURCES, MENTION_RETENTION_MS } from "./mention-inbox-store.js";

// Unlike transcript metadata, this namespace is private to both current and shipped readers.
const PREFIX = "notifications.mentions.audience.";
const END = "notifications.mentions.audience/";
const MAX_AUDIENCE_RECORD_CHARS = 300_000;
const CLEANUP_BATCH_SIZE = 64;
const receiptSchema = mentionAudienceIdentitySchema.extend({
  createdAt: z.number().int().nonnegative(),
  recipients: z.array(z.string().min(1).max(256)).max(MAX_EVERYONE_MENTION_RECIPIENTS),
});
export type MentionAudienceReceipt = z.infer<typeof receiptSchema>;

function key(identity: MentionAudienceIdentity): string {
  // Sender and request are compared, not part of the key: reuse cannot silently retarget a source.
  return (
    PREFIX +
    createHash("sha256")
      .update(
        JSON.stringify([
          identity.agentId,
          identity.sessionKey,
          identity.sessionId,
          identity.sourceId,
        ]),
      )
      .digest("hex")
  );
}

export function readMentionAudience(
  database: DatabaseSync,
  identity: MentionAudienceIdentity,
): MentionAudienceReceipt | undefined {
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", key(identity)),
  );
  if (!row) {
    return undefined;
  }
  if (row.value_json.length > MAX_AUDIENCE_RECORD_CHARS) {
    throw new Error("Mention audience exceeds its record budget");
  }
  const receipt = receiptSchema.parse(JSON.parse(row.value_json));
  if (
    JSON.stringify(mentionAudienceIdentitySchema.parse(receipt)) !==
      JSON.stringify(mentionAudienceIdentitySchema.parse(identity)) ||
    new Set(receipt.recipients).size !== receipt.recipients.length
  ) {
    throw new Error("Mention audience conflicts with the admitted input");
  }
  return receipt;
}

/** Same-owner custody: bounded source count; accepted input retains its original lifetime. */
export function retainMentionAudience(
  database: DatabaseSync,
  identity: MentionAudienceIdentity,
  recipients: readonly string[],
): MentionAudienceReceipt {
  const previous = readMentionAudience(database, identity);
  if (previous) {
    // A current same-source admission fences a cleanup plan prepared before this claim.
    const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
    executeSqliteQuerySync(
      database,
      db
        .updateTable("config_machine_state")
        .set({ updated_at_ms: Date.now() })
        .where("state_key", "=", key(identity)),
    );
    return previous;
  }
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const count =
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("config_machine_state")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("state_key", ">=", PREFIX)
        .where("state_key", "<", END),
    )?.count ?? 0;
  if (count >= MAX_MENTION_SOURCES) {
    throw new Error("Mention audience retention is full; retry after retained sources expire");
  }
  const now = Date.now();
  const receipt = receiptSchema.parse({
    ...identity,
    createdAt: now,
    recipients: [...new Set(recipients)],
  });
  const valueJson = JSON.stringify(receipt);
  if (valueJson.length > MAX_AUDIENCE_RECORD_CHARS) {
    throw new Error("Mention audience exceeds its record budget");
  }
  executeSqliteQuerySync(
    database,
    db.insertInto("config_machine_state").values({
      state_key: key(identity),
      value_json: valueJson,
      updated_at_ms: now,
    }),
  );
  return receipt;
}

export function consumeMentionAudience(
  database: DatabaseSync,
  identity: MentionAudienceIdentity,
): void {
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  executeSqliteQuerySync(
    database,
    db.deleteFrom("config_machine_state").where("state_key", "=", key(identity)),
  );
}

/** Source observations finish before the shared-state writer; no agent writer is acquired. */
export function prepareMentionAudienceCleanup() {
  const due =
    withExistingOpenClawStateDatabaseReadOnly(({ db: database }) => {
      const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
      return executeSqliteQuerySync(
        database,
        db
          .selectFrom("config_machine_state")
          .select(["state_key", "value_json", "updated_at_ms"])
          .where("state_key", ">=", PREFIX)
          .where("state_key", "<", END)
          .where("updated_at_ms", "<=", Date.now() - MENTION_RETENTION_MS)
          .orderBy("updated_at_ms", "asc")
          .limit(CLEANUP_BATCH_SIZE),
      ).rows;
    }) ?? [];
  return due.map((row) => {
    if (row.value_json.length > MAX_AUDIENCE_RECORD_CHARS) {
      throw new Error("Mention audience exceeds its record budget");
    }
    const receipt = receiptSchema.parse(JSON.parse(row.value_json));
    if (key(receipt) !== row.state_key) {
      throw new Error("Invalid mention audience identity");
    }
    // Missing and consumed are terminal facts for this exact request; unavailable throws.
    const retained = hasRetainedSessionPendingInput(receipt, {
      idempotencyKey: receipt.sourceId,
      requestFingerprint: receipt.requestFingerprint,
    });
    return Object.assign(row, { retained });
  });
}

/** The same synchronous owner compares its prepared bytes after acquiring the writer. */
export function applyMentionAudienceCleanup(
  database: DatabaseSync,
  rows: ReturnType<typeof prepareMentionAudienceCleanup>,
): void {
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  for (const row of rows) {
    if (row.retained) {
      executeSqliteQuerySync(
        database,
        db
          .updateTable("config_machine_state")
          .set({ updated_at_ms: Date.now() })
          .where("state_key", "=", row.state_key)
          .where("value_json", "=", row.value_json)
          .where("updated_at_ms", "=", row.updated_at_ms),
      );
    } else {
      executeSqliteQuerySync(
        database,
        db
          .deleteFrom("config_machine_state")
          .where("state_key", "=", row.state_key)
          .where("value_json", "=", row.value_json)
          .where("updated_at_ms", "=", row.updated_at_ms),
      );
    }
  }
}

export function nextMentionAudienceExpiry(database: DatabaseSync): number {
  const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
  const oldest = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("config_machine_state")
      .select((eb) => eb.fn.min<number>("updated_at_ms").as("oldest"))
      .where("state_key", ">=", PREFIX)
      .where("state_key", "<", END),
  )?.oldest;
  return oldest == null ? Infinity : oldest + MENTION_RETENTION_MS;
}
