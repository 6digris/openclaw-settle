import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionArchivedTranscriptCleanupRule,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
} from "./session-accessor.lifecycle-types.js";
import type {
  SessionEntryCommitContext,
  SessionEntryCreateWithTranscriptOptions,
} from "./session-accessor.types.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

export type SessionEntryLifecycleMutationParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  captureArtifactCleanupError?: boolean;
  /** Doctor-only bypass while exact malformed rows are removed in the same transaction. */
  allowCanonicalRepair?: boolean;
  /** Doctor-only synchronous state transfer that commits with the destination entry. */
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  /** Synchronous caller-authority guard checked immediately before lifecycle writes. */
  beforeCommitInTransaction?: () => void;
  /** Retain source authority around the final writer, after projection and native preparation. */
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"];
  /** Non-throwing notification after outer COMMIT, before lifecycle publication and owner cleanup. */
  onLifecycleCommitted?: () => void;
  /**
   * Awaited after successful COMMIT/publication while the same physical writer is retained.
   * Recheck context before side effects; catch best-effort failures and join all native work.
   */
  afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
};
