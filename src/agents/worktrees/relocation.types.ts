import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ManagedWorktreeRecord } from "./types.js";

export type WorktreeSessionReference = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  entryDigest: string;
  lifecycleRevision?: SessionEntry["lifecycleRevision"];
  sessionRoot?: string;
  spawnedCwd?: string;
  spawnedWorkspaceDir?: string;
  worktree?: SessionEntry["worktree"];
};

export type WorktreePathIdentity = { path: string; dev: number; ino: number };

/** A recorded observation is a precondition, never permission to repeat an effect. */
export type WorktreeMovePlan = {
  record: ManagedWorktreeRecord;
  destination: string;
  destinationRoot: WorktreePathIdentity;
  source: WorktreePathIdentity;
  gitDirectory: WorktreePathIdentity;
  commonDirectory: WorktreePathIdentity;
  head: string;
  statusDigest: string;
  sessions: WorktreeSessionReference[];
  projection?: { source: WorktreePathIdentity; destination: string; sessionId: string };
  observation: string;
};

type WorktreeMovePhase = "admitted" | "moving" | "moved" | "verified" | "recovery_required";

export type WorktreeMoveReceipt = {
  operationId: string;
  worktreeId: string;
  phase: WorktreeMovePhase;
  revision: number;
  plan: WorktreeMovePlan;
  createdAt: number;
  updatedAt: number;
  reason?: string;
};

export type WorktreeMovePreview = {
  worktreeId: string;
  destination?: string;
  observation?: string;
  blockers: string[];
  /** Git/SQLite leases cannot account for editors, shells, or other outside writers. */
  maintenanceRequired: true;
};

export type WorktreeMoveParams = {
  id: string;
  destinationRoot: string;
  operationId: string;
  expectedObservation: string;
  /** The operator has stopped outside writers for this checkout and its repository. */
  controlledMaintenance: true;
};

export type WorktreeRelocationOperations = {
  "worktrees.inventory": {
    input: undefined;
    output: {
      worktrees: ManagedWorktreeRecord[];
      relocations: WorktreeMoveReceipt[];
      projections: { worktreeId: string; path: string; sessionId: string; unsettled: boolean }[];
    };
  };
  "worktrees.backupInventory": { input: undefined; output: { roots: string[]; revision: string } };
  "worktrees.projection": {
    input: { id: string };
    output: { path: string; sessionId: string; revision: number; unsettled: boolean } | undefined;
  };
  "worktrees.references": {
    input: {
      config: OpenClawConfig;
      record: ManagedWorktreeRecord;
      projectionPath?: string;
      homeDir: string;
    };
    output: WorktreeSessionReference[];
  };
  "worktrees.verifyReferences": { input: WorktreeMovePlan; output: string[] };
  "worktrees.relocations": { input: undefined; output: WorktreeMoveReceipt[] };
  "worktrees.relocation.admit": {
    input: { operationId: string; executor: string; plan: WorktreeMovePlan; now: number };
    output: { receipt: WorktreeMoveReceipt; admitted: boolean };
  };
  "worktrees.relocation.recover": {
    input: { operationId: string; executor: string; now: number };
    output: WorktreeMoveReceipt;
  };
  "worktrees.relocation.advance": {
    input: {
      operationId: string;
      executor: string;
      revision: number;
      phase: WorktreeMovePhase;
      now: number;
      reason?: string;
      projectionRevision?: number;
    };
    output: WorktreeMoveReceipt;
  };
};
