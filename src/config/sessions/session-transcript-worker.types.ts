import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import type {
  BuildSessionEntryOptions,
  SessionFileEntry,
  readSessionEntryResetRecallCutoff,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type {
  SessionCostUsageCacheRead,
  SessionCostUsageCacheReadResult,
} from "../../infra/session-cost-usage-cache-read.js";
import type { SensitiveTextRedactionSnapshot } from "../../logging/redact.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type { SessionTranscriptBoundedActiveContext } from "./session-accessor.sqlite-active-context.js";
import type {
  SessionBranchSummaryReadRequest,
  SessionBranchSummaryReadResult,
} from "./session-accessor.sqlite-branches.js";
import type {
  SessionIdentityEvidenceIdentity,
  SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import type {
  readSessionTranscriptModelContext,
  SessionModelContextLimits,
} from "./session-accessor.sqlite-model-context.js";
import type { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryListScope,
  SessionEntrySummary,
  SessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type {
  SessionHistoryWorkerRequest,
  SessionHistoryWorkerResult,
} from "./session-history-types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { ResolvedSqliteStoreTarget } from "./session-sqlite-target.js";
import type {
  SessionStoreTargetInventoryRequest,
  SessionStoreTargetInventoryResult,
} from "./session-store-target-inventory.js";
import type { SessionTranscriptStorageUnavailableError } from "./session-transcript-projection-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type PreparedSessionTranscriptHydration =
  | { kind: "full"; snapshot: ReturnType<typeof loadTranscriptReadSnapshotSync> }
  | { kind: "bounded"; snapshot: SessionTranscriptBoundedActiveContext };

export type SessionModelContextWorkerInput = {
  kind: "model-context";
  target: SessionTranscriptRuntimeTarget;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  limits?: SessionModelContextLimits;
};

export type SessionSqliteTargetWorkerInput = {
  kind: "sqlite-target";
  storePath: string;
  agentId?: string;
  defaultAgentId?: string;
  env: NodeJS.ProcessEnv;
  registeredDatabases: readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[];
};

export type SessionEntryWorkerInput = {
  kind: "session-entry";
  absPath: string;
  options: Omit<BuildSessionEntryOptions, "onTranscriptMessage" | "parseYieldEveryLines"> & {
    agentId: string;
    sessionId: string;
    storePath: string;
  };
  admission?: UserTurnTranscriptAdmissionReceipt;
  redaction: SensitiveTextRedactionSnapshot;
};

export type SessionTranscriptHistoryWorkerInput = {
  kind: "history-page";
  database: { agentId: string; path: string };
  request: SessionHistoryWorkerRequest;
  target: Omit<PreparedSessionHistoryReadTarget, "database">;
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionTranscriptHydrationWorkerInput = {
  kind: "transcript-hydration";
  database: { agentId: string; path: string };
  target: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv };
  resolvedScope: ResolvedTranscriptReadScope;
  limits?: { maxBytes: number; maxEvents: number };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionRowPresenceWorkerInput = {
  kind: "session-row-presence";
  database: { agentId: string; path: string };
  scope: SessionAccessScope & { databaseAgentId: string };
};

export type SessionMembersWorkerInput = {
  kind: "session-members";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
};

export type SessionProgressCardWorkerInput = {
  kind: "session-progress-card";
  database: { agentId: string; path: string };
  sessionKey: string;
  env: NodeJS.ProcessEnv;
};

export type SessionUsageCacheWorkerInput = {
  kind: "usage-cache";
  database: { agentId: string; path: string };
  request: SessionCostUsageCacheRead;
  env: NodeJS.ProcessEnv;
};

export type SessionEntryListWorkerInput = {
  kind: "session-entry-list";
  database: { agentId: string; path: string };
  scope: SessionEntryListScope;
};

export type SessionEntryListWorkerResult = {
  kind: "session-entry-list";
  entries: SessionEntrySummary[];
};

export type SessionTargetInventoryWorkerInput = {
  kind: "session-target-inventory";
  request: SessionStoreTargetInventoryRequest;
};

export type SessionIdentityEvidenceWorkerInput = {
  kind: "session-identity-evidence";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  identities: readonly SessionIdentityEvidenceIdentity[];
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionIdentityEvidenceWorkerResult = {
  kind: "session-identity-evidence";
  evidence: SessionIdentityEvidenceResult[];
};

export type SessionBranchSummaryWorkerInput = {
  kind: "branch-summaries";
  request: SessionBranchSummaryReadRequest;
};

export type SessionTranscriptWorkerValues = {
  "transcript-hydration": PreparedSessionTranscriptHydration;
  "sqlite-target": { target: ResolvedSqliteStoreTarget };
  "branch-summaries": SessionBranchSummaryReadResult;
  "history-page": SessionHistoryWorkerResult;
  "session-row-presence": boolean;
  "session-members": SessionMember[];
  "session-progress-card": { kind: "session-progress-card"; card: ProgressCard | null };
  "session-entry-list": SessionEntryListWorkerResult;
  "session-target-inventory": SessionStoreTargetInventoryResult;
  "session-identity-evidence": SessionIdentityEvidenceWorkerResult;
  "usage-cache": SessionCostUsageCacheReadResult;
  "model-context": ReturnType<typeof readSessionTranscriptModelContext>;
  "session-entry": {
    entry: SessionFileEntry | null;
    resetRecallCutoff: ReturnType<typeof readSessionEntryResetRecallCutoff>;
  };
};

export type SessionTranscriptWorkerReply<Kind extends keyof SessionTranscriptWorkerValues> =
  | {
      ok: true;
      value: SessionTranscriptWorkerValues[Kind];
      closedHistoryDatabase?: SessionTranscriptHistoryWorkerInput["database"];
    }
  | {
      ok: false;
      error:
        | { kind: "read-error"; message: string; payload: OpenClawStateWorkerErrorPayload }
        | { kind: "cold"; sessionId: string }
        | { kind: "projection"; sessionId: string }
        | { kind: "storage"; reason?: SessionTranscriptStorageUnavailableError["reason"] }
        | { kind: "fence"; message: string };
    };
