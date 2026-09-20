import { z } from "zod";
/** SQLite-backed persistence for durable per-agent Talk voice-call records. */
import { compileSqliteQueryBindings, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import type { ClientVoiceAppLaunchOrigin } from "./client-voice-app-launch-policy.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

const VOICE_SESSION_CACHE_SCOPE = "talk-client-voice-sessions";
export const VOICE_SESSION_RECORD_VERSION = 1;
export const VOICE_SESSION_STALE_AFTER_MS = 6 * 60 * 60_000;

export type ClientVoiceToolEffect = {
  voicePolicyId?: string;
  runId: string;
  toolCallId?: string;
  toolName: string;
  startedAt: number;
  finishedAt?: number;
  status: "started" | "succeeded" | "failed" | "cancelled" | "blocked";
};

export type ClientVoiceSessionRecord = {
  version: typeof VOICE_SESSION_RECORD_VERSION;
  voiceSessionId: string;
  agentId: string;
  sessionKey: string;
  provider?: string;
  origin: "client" | "relay";
  status: "open" | "closed";
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  consultRunIds: string[];
  effects: ClientVoiceToolEffect[];
  digestDeliveredAt?: number;
  /** Bounded hashes of transcript entries that must succeed before close can commit. */
  transcriptFailureKeys: string[];
  /** Declared at create when the client speaks the transcript protocol (sent sessionKey). */
  transcriptCapable?: boolean;
  /** Set once a finalized user utterance persisted; gates spoken confirmation capability. */
  hasUserTranscript?: boolean;
};

export type ClientVoiceRunBinding = Readonly<{
  originAuthority?: ClientVoiceAppLaunchOrigin;
  agentId: string;
  voiceSessionId: string;
  sessionKey: string;
}>;

const TRANSCRIPT_FAILURE_KEY_PATTERN = /^[0-9a-f]{64}$/;

const clientVoiceToolEffectSchema = z.looseObject({
  runId: z.string(),
  toolName: z.string(),
  startedAt: z.number(),
  status: z.enum(["started", "succeeded", "failed", "cancelled", "blocked"]),
});

const clientVoiceSessionRecordSchema = z.looseObject({
  version: z.literal(VOICE_SESSION_RECORD_VERSION),
  voiceSessionId: z.string(),
  agentId: z.string(),
  sessionKey: z.string(),
  provider: z
    .string()
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.trim())
    .optional(),
  origin: z.enum(["client", "relay"]),
  status: z.enum(["open", "closed"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  consultRunIds: z
    .unknown()
    .optional()
    .transform((value) =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [],
    ),
  effects: z
    .unknown()
    .optional()
    .transform((value) =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            const parsed = clientVoiceToolEffectSchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          })
        : [],
    ),
  transcriptFailureKeys: z
    .unknown()
    .optional()
    .transform((value) => value ?? [])
    .pipe(
      z
        .array(z.string().regex(TRANSCRIPT_FAILURE_KEY_PATTERN))
        .max(VOICE_TRANSCRIPT_MAX_UNRESOLVED)
        .refine((keys) => new Set(keys).size === keys.length),
    ),
});

function parseVoiceSessionRecord(value: unknown): ClientVoiceSessionRecord | undefined {
  const parsed = clientVoiceSessionRecordSchema.safeParse(value);
  return parsed.success ? (parsed.data as ClientVoiceSessionRecord) : undefined;
}

export function parseStoredVoiceSessionRecord(
  valueJson: unknown,
): ClientVoiceSessionRecord | undefined {
  if (typeof valueJson !== "string") {
    return undefined;
  }
  try {
    return parseVoiceSessionRecord(JSON.parse(valueJson));
  } catch {
    return undefined;
  }
}

export function readVoiceSessionRecord(
  agentId: string,
  voiceSessionId: string,
): ClientVoiceSessionRecord | undefined {
  return readVoiceSessionRecordInTransaction(
    openOpenClawAgentDatabase({ agentId }),
    voiceSessionId,
  );
}

function voiceSessionRowsQuery(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "cache_entries">>(database.db)
    .selectFrom("cache_entries")
    .select("value_json")
    .where("scope", "=", VOICE_SESSION_CACHE_SCOPE);
}

export function readVoiceSessionRecordInTransaction(
  database: OpenClawAgentDatabase,
  voiceSessionId: string,
): ClientVoiceSessionRecord | undefined {
  const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
    voiceSessionRowsQuery(database).where("key", "=", voiceSessionId),
  );
  const row = /* sqlite-allow-raw: Compiled SQL keeps native get error ownership. */ database.db
    .prepare(compiled.sql)
    .get(...bind());
  return parseStoredVoiceSessionRecord(row?.value_json);
}

export function readVoiceSessionRecordRows(agentId: string, updatedBefore?: number) {
  const database = openOpenClawAgentDatabase({ agentId });
  const query = voiceSessionRowsQuery(database);
  const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
    updatedBefore === undefined
      ? query.orderBy("updated_at", "desc")
      : query.where("updated_at", "<=", updatedBefore),
  );
  return /* sqlite-allow-raw: Compiled SQL snapshots recovery candidates before awaits. */ database.db
    .prepare(compiled.sql)
    .all(...bind());
}

export function writeVoiceSessionRecordInTransaction(
  database: OpenClawAgentDatabase,
  record: ClientVoiceSessionRecord,
): void {
  const { compiled, bind } = compileSqliteQueryBindings<ClientVoiceSessionRecord>((p) =>
    getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "cache_entries">>(database.db)
      .insertInto("cache_entries")
      .values({
        scope: VOICE_SESSION_CACHE_SCOPE,
        key: p((value) => value.voiceSessionId),
        value_json: p((value) => JSON.stringify(value)),
        blob: null,
        expires_at: null,
        updated_at: p((value) => value.updatedAt),
      })
      .onConflict((conflict) =>
        conflict.columns(["scope", "key"]).doUpdateSet((eb) => ({
          value_json: eb.ref("excluded.value_json"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      ),
  );
  // sqlite-allow-raw: Compiled SQL preserves native preparation before JSON evaluation.
  database.db.prepare(compiled.sql).run(...bind(record));
}

export function assertVoiceSessionOwnership(
  record: ClientVoiceSessionRecord,
  params: { agentId: string; sessionKey: string },
): void {
  if (record.agentId !== params.agentId || record.sessionKey !== params.sessionKey) {
    throw new Error("voice session does not belong to this agent session");
  }
}

export function operationKey(agentId: string, voiceSessionId: string): string {
  return `${agentId}\0${voiceSessionId}`;
}

export function createOrResumeVoiceSessionRecord(params: {
  agentId: string;
  sessionKey: string;
  provider?: string;
  origin: "client" | "relay";
  transcriptCapable?: boolean;
  voiceSessionId: string;
  now: number;
}): void {
  const { voiceSessionId, provider, now } = params;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const existing = readVoiceSessionRecordInTransaction(database, voiceSessionId);
      if (existing) {
        assertVoiceSessionOwnership(existing, params);
        if (existing.origin !== params.origin) {
          throw new Error("voice session origin does not match");
        }
        if (existing.status !== "open") {
          throw new Error("voice session is already closed");
        }
        if (existing.provider && provider && existing.provider !== provider) {
          throw new Error("voice session provider does not match");
        }
        if (!existing.provider && provider) {
          existing.provider = provider;
        }
        if (params.transcriptCapable === true) {
          existing.transcriptCapable = true;
        }
        existing.updatedAt = now;
        writeVoiceSessionRecordInTransaction(database, existing);
        return;
      }
      writeVoiceSessionRecordInTransaction(database, {
        version: VOICE_SESSION_RECORD_VERSION,
        voiceSessionId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(provider ? { provider } : {}),
        origin: params.origin,
        ...(params.transcriptCapable === true ? { transcriptCapable: true } : {}),
        status: "open",
        createdAt: now,
        updatedAt: now,
        consultRunIds: [],
        effects: [],
        transcriptFailureKeys: [],
      });
    },
    { agentId: params.agentId },
  );
}

export function recordVoiceSessionAppLaunchPolicyUse(
  binding: ClientVoiceRunBinding,
  params: { runId: string; toolCallId: string; policyId: string },
): void {
  runOpenClawAgentWriteTransaction(
    (database) => {
      const record = readVoiceSessionRecordInTransaction(database, binding.voiceSessionId);
      if (!record) {
        throw new Error("Voice app launch call no longer exists");
      }
      assertVoiceSessionOwnership(record, binding);
      const effect = record.effects.find(
        (entry) => entry.runId === params.runId && entry.toolCallId === params.toolCallId,
      );
      if (!effect) {
        throw new Error("Voice app launch has no tool execution record");
      }
      effect.voicePolicyId = params.policyId;
      writeVoiceSessionRecordInTransaction(database, record);
    },
    { agentId: binding.agentId },
  );
}

/**
 * Confirmation applies only when the session can observe spoken approvals:
 * relay sessions (server hears utterances) or clients that report transcripts.
 * Legacy clients without transcript reporting keep pre-gate behavior.
 */
export function isClientVoiceSessionConfirmable(binding: ClientVoiceRunBinding): boolean {
  const record = readVoiceSessionRecord(binding.agentId, binding.voiceSessionId);
  return (
    record?.origin === "relay" ||
    record?.transcriptCapable === true ||
    record?.hasUserTranscript === true
  );
}

/** Validate ownership and open state before starting a voice-bound consult. */
export function assertClientVoiceSessionOpen(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
}): "client" | "relay" {
  const record = readVoiceSessionRecord(params.agentId, params.voiceSessionId);
  if (!record) {
    throw new Error("voice session not found");
  }
  assertVoiceSessionOwnership(record, params);
  if (record.status !== "open") {
    throw new Error("voice session is closed");
  }
  return record.origin;
}

/** Validate durable ownership without rejecting an idempotent close retry. */
export function resolveClientVoiceSessionOrigin(params: {
  agentId: string;
  sessionKey: string;
  voiceSessionId: string;
}): "client" | "relay" {
  const record = readVoiceSessionRecord(params.agentId, params.voiceSessionId);
  if (!record) {
    throw new Error("voice session not found");
  }
  assertVoiceSessionOwnership(record, params);
  return record.origin;
}
