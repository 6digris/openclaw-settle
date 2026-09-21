import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readSqliteNumberPragma } from "../../infra/sqlite-pragma.test-support.js";
import { isLockOwnerDefinitelyStale } from "../../infra/stale-lock-file.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  admitWorktreeRunLeaseRow,
  claimWorktreeRemovalRow,
  deleteRegistryWorktree,
  getRegistryWorktree,
  insertRegistryWorktree,
  retireMissingRegistryWorktree,
} from "./registry.js";
import {
  admitWorktreeRelocation,
  advanceWorktreeRelocation,
  assertNoWorktreeRelocation,
  ensureWorktreeRelocationSchema,
  readWorktreeBackupInventory,
  readWorktreeRelocations,
  recoverWorktreeRelocation,
} from "./relocation.kernel.js";
import type { WorktreeMovePlan, WorktreeMoveReceipt } from "./relocation.types.js";

vi.mock("../../infra/stale-lock-file.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/stale-lock-file.js")>()),
  isLockOwnerDefinitelyStale: vi.fn(() => false),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("durable worktree relocation custody", () => {
  let env: NodeJS.ProcessEnv;
  let db: DatabaseSync;
  let plan: WorktreeMovePlan;
  let operationId: string;
  let executor: string;
  let schemaVersion: number;
  const transact = <T>(run: () => T) => runOpenClawStateWriteTransaction(run, { env });
  const admit = () =>
    transact(() => admitWorktreeRelocation(db, { operationId, executor, plan, now: 10 }));
  const advance = (receipt: WorktreeMoveReceipt, phase: WorktreeMoveReceipt["phase"]) =>
    transact(() =>
      advanceWorktreeRelocation(db, {
        operationId,
        executor,
        revision: receipt.revision,
        phase,
        now: 20,
      }),
    );

  beforeEach(() => {
    env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-worktree-move-custody-") };
    executor = randomUUID();
    operationId = randomUUID();
    vi.mocked(isLockOwnerDefinitelyStale).mockReturnValue(false);
    const record = {
      id: randomUUID(),
      name: "task",
      repoFingerprint: "0123456789abcdef",
      repoRoot: path.join(env.OPENCLAW_STATE_DIR!, "repo"),
      path: path.join(env.OPENCLAW_STATE_DIR!, "worktrees", "0123456789abcdef", "task"),
      branch: "openclaw/task",
      baseRef: "HEAD",
      ownerKind: "manual" as const,
      createdAt: 1,
      lastActiveAt: 2,
    };
    insertRegistryWorktree(env, record);
    schemaVersion = readSqliteNumberPragma(openOpenClawStateDatabase({ env }).db, "user_version");
    ensureWorktreeRelocationSchema({ env });
    db = openOpenClawStateDatabase({ env }).db;
    plan = {
      record: getRegistryWorktree(env, record.id)!,
      destinationRoot: { path: path.join(env.OPENCLAW_STATE_DIR!, "next"), dev: 1, ino: 1 },
      destination: path.join(env.OPENCLAW_STATE_DIR!, "next", record.repoFingerprint, record.name),
      source: { path: record.path, dev: 1, ino: 2 },
      gitDirectory: {
        path: path.join(record.repoRoot, ".git", "worktrees", "task"),
        dev: 1,
        ino: 3,
      },
      commonDirectory: { path: path.join(record.repoRoot, ".git"), dev: 1, ino: 4 },
      head: "a".repeat(40),
      statusDigest: "b".repeat(64),
      sessions: [],
      observation: "c".repeat(64),
    };
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("adds its lazy table without changing the database version or existing registry", () => {
    ensureWorktreeRelocationSchema({ env });
    expect(readSqliteNumberPragma(db, "user_version")).toBe(schemaVersion);
    expect(getRegistryWorktree(env, plan.record.id)).toEqual(plan.record);
    expect(readWorktreeRelocations(db)).toEqual([]);
  });

  it("does not repeat admission even when an identical receipt is replayed", () => {
    const first = admit();
    expect(first.admitted).toBe(true);
    expect(admit()).toEqual({ receipt: first.receipt, admitted: false });
    expect(() =>
      transact(() =>
        admitWorktreeRelocation(db, {
          operationId,
          executor,
          plan: { ...plan, destination: `${plan.destination}-other` },
          now: 11,
        }),
      ),
    ).toThrow("different intent");
    expect(readWorktreeRelocations(db)).toHaveLength(1);
  });

  it("keeps an unresolved intent ahead of lease cleanup, removal, retirement and backup", () => {
    admit();
    const lease = {
      worktreeId: plan.record.id,
      token: randomUUID(),
      pid: process.pid,
      startTime: null,
      now: 100,
    };
    expect(() => admitWorktreeRunLeaseRow(env, lease)).toThrow("unresolved");
    expect(() => claimWorktreeRemovalRow(env, lease)).toThrow("unresolved");
    expect(() => retireMissingRegistryWorktree(env, plan.record, 100)).toThrow("unresolved");
    expect(() => deleteRegistryWorktree(env, plan.record.id)).toThrow("unresolved");
    expect(() => readWorktreeBackupInventory(db)).toThrow("unresolved");
    expect(getRegistryWorktree(env, plan.record.id)).toEqual(plan.record);
  });

  it("does not steal live or unknown execution and never infers child completion from parent death", () => {
    let receipt = admit().receipt;
    receipt = advance(receipt, "moving");
    vi.mocked(isLockOwnerDefinitelyStale).mockReturnValue(true);
    expect(() =>
      transact(() =>
        recoverWorktreeRelocation(db, { operationId, executor: "successor", now: 30 }),
      ),
    ).toThrow("Filesystem completion is unproven");
    receipt = advance(receipt, "moved");
    vi.mocked(isLockOwnerDefinitelyStale).mockReturnValue(false);
    expect(() =>
      transact(() =>
        recoverWorktreeRelocation(db, { operationId, executor: "successor", now: 30 }),
      ),
    ).toThrow("may still be active");
    expect(readWorktreeRelocations(db)[0]).toEqual(receipt);
  });

  it("transfers metadata custody once and retains the fence through the final binding transaction", () => {
    let receipt = advance(admit().receipt, "moving");
    receipt = advance(receipt, "moved");
    vi.mocked(isLockOwnerDefinitelyStale).mockReturnValue(true);
    const successor = randomUUID();
    const recovered = transact(() =>
      recoverWorktreeRelocation(db, { operationId, executor: successor, now: 30 }),
    );
    expect(() => advance(receipt, "verified")).toThrow("executor or revision changed");
    expect(() => assertNoWorktreeRelocation(db, plan.record.id)).toThrow("unresolved");
    executor = successor;
    receipt = advance(recovered, "moved");
    receipt = advance(receipt, "verified");
    expect(receipt.phase).toBe("verified");
    expect(getRegistryWorktree(env, plan.record.id)).toEqual({
      ...plan.record,
      path: plan.destination,
    });
    expect(() => assertNoWorktreeRelocation(db)).not.toThrow();
    expect(readWorktreeBackupInventory(db).roots).toEqual(
      [plan.record.repoRoot, plan.destination].toSorted(),
    );
    expect(admit()).toEqual({ admitted: false, receipt });
  });

  it("keeps another operation from replacing an unresolved receipt", () => {
    admit();
    operationId = randomUUID();
    expect(admit).toThrow("unresolved");
    expect(readWorktreeRelocations(db)).toHaveLength(1);
  });

  it("rejects a cwd captured before a completed move at the run's actual lease admission", () => {
    let receipt = advance(admit().receipt, "moving");
    receipt = advance(receipt, "moved");
    advance(receipt, "verified");
    const lease = {
      worktreeId: plan.record.id,
      token: randomUUID(),
      pid: process.pid,
      startTime: null,
      now: 30,
    };
    expect(() =>
      admitWorktreeRunLeaseRow(env, { ...lease, candidatePaths: [plan.source.path] }),
    ).toThrow("moved after this run");
    expect(() =>
      admitWorktreeRunLeaseRow(env, { ...lease, candidatePaths: [plan.destination] }),
    ).not.toThrow();
  });
});
