import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  openSessionEntryReadView,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withLocalWorkspaceProjection } from "../../gateway/worker-environments/local-workspace-projection.js";
import { localWorkspaceStore } from "../../gateway/worker-environments/local-workspace-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { requireGit } from "./git.js";
import { insertRegistryWorktree } from "./registry.js";
import {
  readManagedWorktreeBackupInventory,
  readWorktreeMoveReceipts,
} from "./relocation-store.js";
import { resolveWorktreeIdForPath } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const initializeRepository = useManagedWorktreeTestRepository();

describe.skipIf(process.platform === "win32")("native managed worktree relocation", () => {
  let root: string;
  let repo: string;
  let destinationRoot: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.realpath(tempDirs.make("openclaw-worktree-move-"));
    repo = await initializeRepository(root);
    destinationRoot = path.join(root, "external-workspaces");
    await fs.mkdir(destinationRoot, { mode: 0o700 });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
  });

  it("preserves index, dirty, untracked, ignored bytes and Git identity without replaying a move", async () => {
    const record = await service.create({ repoRoot: repo, name: "owned-task", baseRef: "HEAD" });
    await fs.writeFile(path.join(record.path, "README.md"), "staged change\n");
    await requireGit(record.path, ["add", "README.md"]);
    await fs.writeFile(path.join(record.path, "README.md"), "unstaged change\n");
    await fs.writeFile(path.join(record.path, "untracked.txt"), "untracked bytes\n");
    await fs.writeFile(path.join(repo, ".git", "info", "exclude"), "dependencies/\n");
    await fs.mkdir(path.join(record.path, "dependencies"));
    await fs.writeFile(path.join(record.path, "dependencies", "retained"), "ignored bytes\n");
    const before = {
      inode: (await fs.stat(record.path)).ino,
      status: await requireGit(record.path, ["status", "--porcelain=v1"]),
      head: await requireGit(record.path, ["rev-parse", "HEAD"]),
      index: await requireGit(record.path, ["show", ":README.md"]),
      refs: await requireGit(repo, ["show-ref"]),
    };
    const preview = await service.previewMove({ id: record.id, destinationRoot });
    expect(preview.blockers).toEqual([]);
    const params = {
      id: record.id,
      destinationRoot,
      operationId: randomUUID(),
      expectedObservation: preview.observation!,
      controlledMaintenance: true as const,
    };
    const result = await service.move(params);
    expect(result.phase).toBe("verified");
    expect(result.destination).toBe(
      path.join(destinationRoot, record.repoFingerprint, record.name),
    );
    expect((await fs.stat(result.destination)).ino).toBe(before.inode);
    await expect(fs.lstat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await requireGit(result.destination, ["status", "--porcelain=v1"])).toBe(before.status);
    expect(await requireGit(result.destination, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(await requireGit(result.destination, ["show", ":README.md"])).toBe(before.index);
    expect(await requireGit(repo, ["show-ref"])).toBe(before.refs);
    expect(
      await fs.readFile(path.join(result.destination, "dependencies", "retained"), "utf8"),
    ).toBe("ignored bytes\n");
    expect(await service.move(params)).toEqual(result);
    await expect(service.move({ ...params, destinationRoot: root })).rejects.toThrow(
      "different relocation intent",
    );
    expect((await service.verifyMove(result.operationId)).verified).toBe(true);
    await expect(resolveWorktreeIdForPath({ candidatePaths: [record.path], env })).rejects.toThrow(
      "Workspace moved",
    );
    expect((await service.inventory()).worktrees).toEqual([
      { ...record, path: result.destination },
    ]);
    expect((await readManagedWorktreeBackupInventory(env)).roots).toEqual(
      [repo, result.destination].toSorted(),
    );
  });

  it("refuses occupied destinations and stale previews without touching source content", async () => {
    const record = await service.create({ repoRoot: repo, name: "retained", baseRef: "HEAD" });
    const preview = await service.previewMove({ id: record.id, destinationRoot });
    await fs.writeFile(path.join(record.path, "README.md"), "later edit\n");
    await expect(
      service.move({
        id: record.id,
        destinationRoot,
        operationId: randomUUID(),
        expectedObservation: preview.observation!,
        controlledMaintenance: true,
      }),
    ).rejects.toThrow("changed since preview");
    await fs.mkdir(path.join(destinationRoot, record.repoFingerprint, record.name), {
      recursive: true,
      mode: 0o700,
    });
    expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
      "already exists",
    );
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("later edit\n");
    expect((await service.inventory()).relocations).toEqual([]);
  });

  it("settles a private projection and moves the same session incarnation with all local roots", async () => {
    const sessionKey = "agent:main:relocation";
    const sessionId = randomUUID();
    const record = await service.create({
      repoRoot: repo,
      name: "session-task",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env });
    const scope = { agentId: "main", sessionKey, storePath, env };
    const worktree = { id: record.id, branch: record.branch, repoRoot: record.repoRoot };
    await upsertSessionEntryCore(scope, {
      sessionId,
      lifecycleRevision: "lifecycle-1",
      updatedAt: 1,
      worktree,
      sessionRoot: record.path,
      spawnedCwd: path.join(record.path, "subdirectory"),
      spawnedWorkspaceDir: record.path,
    });
    const entry = openSessionEntryReadView(scope).get(sessionKey)!;
    const projection = await withLocalWorkspaceProjection(
      {
        worktree: record,
        env,
        agentId: "main",
        sessionKey,
        sessionId,
        lifecycleRevision: entry.lifecycleRevision ?? null,
        assertCurrent: () => {},
      },
      (workspace) => workspace.prepare(),
    );
    await fs.writeFile(path.join(projection, "guest.txt"), "accepted guest edit\n");
    await patchSessionEntryCore(
      scope,
      () => ({
        spawnedCwd: path.join(projection, "subdirectory"),
        spawnedWorkspaceDir: projection,
      }),
      { preserveActivity: true },
    );
    const beforeMove = openSessionEntryReadView(scope).get(sessionKey)!;
    const preview = await service.previewMove({ id: record.id, destinationRoot });
    expect(preview.blockers).toEqual([]);
    const receipt = await service.move({
      id: record.id,
      destinationRoot,
      operationId: randomUUID(),
      expectedObservation: preview.observation!,
      controlledMaintenance: true,
    });
    expect(receipt.phase).toBe("verified");
    const movedProjection = path.join(destinationRoot, ".projections", record.id, "workspace");
    expect(localWorkspaceStore(env).get(record.id)?.projection_path).toBe(movedProjection);
    for (const directory of [receipt.destination, movedProjection]) {
      expect(await fs.readFile(path.join(directory, "guest.txt"), "utf8")).toBe(
        "accepted guest edit\n",
      );
    }
    expect(openSessionEntryReadView(scope).get(sessionKey)).toEqual({
      ...beforeMove,
      sessionRoot: receipt.destination,
      spawnedCwd: path.join(movedProjection, "subdirectory"),
      spawnedWorkspaceDir: movedProjection,
    });
    expect((await service.verifyMove(receipt.operationId)).verified).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "retains links whose meaning would change instead of repairing dependencies",
    async () => {
      const record = await service.create({ repoRoot: repo, name: "linked", baseRef: "HEAD" });
      const link = path.join(record.path, "dependency");
      await fs.symlink(path.join(record.path, "README.md"), link);
      expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
        "absolute link",
      );
      await fs.unlink(link);
      await fs.symlink("../shared-dependencies", link);
      expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
        "relative link",
      );
      expect(await fs.readlink(link)).toBe("../shared-dependencies");
    },
  );

  it("rejects a destination within the projection before intent admission or filesystem effects", async () => {
    const sessionKey = "agent:main:projection-destination";
    const record = await service.create({
      repoRoot: repo,
      name: "projection-destination",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const projection = await withLocalWorkspaceProjection(
      {
        worktree: record,
        env,
        agentId: "main",
        sessionKey,
        sessionId: randomUUID(),
        lifecycleRevision: null,
        assertCurrent: () => {},
      },
      (workspace) => workspace.prepare(),
    );
    const nested = path.join(projection, "destination");
    await fs.mkdir(nested, { mode: 0o700 });
    const originalGitDirectory = await requireGit(record.path, ["rev-parse", "--absolute-git-dir"]);
    for (const candidateDestinationRoot of [projection, nested]) {
      expect(
        (await service.previewMove({ id: record.id, destinationRoot: candidateDestinationRoot }))
          .blockers[0],
      ).toContain("inside the source projection");
      await expect(
        service.move({
          id: record.id,
          destinationRoot: candidateDestinationRoot,
          operationId: randomUUID(),
          expectedObservation: "a".repeat(64),
          controlledMaintenance: true,
        }),
      ).rejects.toThrow("inside the source projection");
    }
    expect((await service.inventory()).relocations).toEqual([]);
    expect((await service.inventory()).worktrees[0]?.path).toBe(record.path);
    expect(await requireGit(record.path, ["rev-parse", "--absolute-git-dir"])).toBe(
      originalGitDirectory,
    );
    expect(await fs.readdir(nested)).toEqual([]);
    expect(localWorkspaceStore(env).get(record.id)?.projection_path).toBe(projection);
  });

  it("retains a partial Git move without replay or cleanup when the projection rename fails", async () => {
    const sessionKey = "agent:main:partial-move";
    const record = await service.create({
      repoRoot: repo,
      name: "partial",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    const projection = await withLocalWorkspaceProjection(
      {
        worktree: record,
        env,
        agentId: "main",
        sessionKey,
        sessionId: randomUUID(),
        lifecycleRevision: null,
        assertCurrent: () => {},
      },
      (workspace) => workspace.prepare(),
    );
    await fs.writeFile(path.join(projection, "retained.txt"), "retained bytes\n");
    const unrelated = await service.create({
      repoRoot: repo,
      name: "cleanup-eligible",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:cleanup-eligible",
    });
    const preview = await service.previewMove({ id: record.id, destinationRoot });
    expect(preview.blockers).toEqual([]);
    const params = {
      id: record.id,
      destinationRoot,
      operationId: randomUUID(),
      expectedObservation: preview.observation!,
      controlledMaintenance: true as const,
    };
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (source === projection) {
        throw Object.assign(new Error("Injected projection rename failure"), { code: "EIO" });
      }
      return await originalRename(source, destination);
    });
    const receipt = await service.move(params);
    rename.mockRestore();
    expect(receipt.phase).toBe("recovery_required");
    const beforeCleanup = await service.inventory();
    const persistedReceipts = await readWorktreeMoveReceipts(env);
    const refs = await requireGit(repo, ["show-ref"]);
    const shouldRemoveOwner = vi.fn(() => true);
    const remove = vi.spyOn(service, "remove");
    // An unresolved move fences the whole cleanup pass, including unrelated
    // eligible worktrees, before GC can retire paths or prune recovery evidence.
    await expect(service.gc({ limits: { maxCount: 0 }, shouldRemoveOwner })).rejects.toThrow(
      "Workspace relocation is unresolved",
    );
    expect(shouldRemoveOwner).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await service.inventory()).toEqual(beforeCleanup);
    expect(await readWorktreeMoveReceipts(env)).toEqual(persistedReceipts);
    expect(await requireGit(repo, ["show-ref"])).toBe(refs);
    expect(await fs.readFile(path.join(unrelated.path, "README.md"), "utf8")).toBe("base\n");
    await expect(fs.lstat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(receipt.destination, "retained.txt"), "utf8")).toBe(
      "retained bytes\n",
    );
    expect(await fs.readFile(path.join(projection, "retained.txt"), "utf8")).toBe(
      "retained bytes\n",
    );
    expect((await service.inventory()).worktrees.find((row) => row.id === record.id)?.path).toBe(
      record.path,
    );
    await expect(service.move(params)).rejects.toThrow("Filesystem completion is unproven");
    await expect(readManagedWorktreeBackupInventory(env)).rejects.toThrow("unresolved");
    expect((await service.verifyMove(receipt.operationId)).verified).toBe(false);
  });

  it("refuses a destination namespace writable by another principal", async () => {
    const record = await service.create({ repoRoot: repo, name: "private-root", baseRef: "HEAD" });
    await fs.chmod(destinationRoot, 0o777);
    expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
      "not writable by other users",
    );
    expect((await service.inventory()).relocations).toEqual([]);
  });

  it.each(["HOME", "OPENCLAW_HOME"] as const)(
    "uses captured %s when rejecting a configured cwd that would become stale",
    async (homeSource) => {
      const record = await service.create({
        repoRoot: repo,
        name: "configured-cwd",
        baseRef: "HEAD",
      });
      const configured = new ManagedWorktreeService({
        env: {
          ...env,
          HOME: homeSource === "HOME" ? root : path.join(root, "other-home"),
          OPENCLAW_HOME: homeSource === "OPENCLAW_HOME" ? root : undefined,
        },
        getConfig: () => ({
          agents: { defaults: { cwd: `~/${path.relative(root, record.path)}` } },
        }),
      });
      expect(
        (await configured.previewMove({ id: record.id, destinationRoot })).blockers[0],
      ).toContain("configured agent workspace or cwd");
      expect((await service.inventory()).relocations).toEqual([]);
    },
  );

  it("rejects an existing projection namespace symlink before creating anything outside the root", async () => {
    const sessionKey = "agent:main:namespace";
    const record = await service.create({
      repoRoot: repo,
      name: "namespace",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: sessionKey,
    });
    await withLocalWorkspaceProjection(
      {
        worktree: record,
        env,
        agentId: "main",
        sessionKey,
        sessionId: randomUUID(),
        lifecycleRevision: null,
        assertCurrent: () => {},
      },
      (workspace) => workspace.prepare(),
    );
    const preview = await service.previewMove({ id: record.id, destinationRoot });
    expect(preview.blockers).toEqual([]);
    const outside = path.join(root, "outside-destination");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(destinationRoot, ".projections"));
    expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
      "symlink aliases",
    );
    await expect(
      service.move({
        id: record.id,
        destinationRoot,
        operationId: randomUUID(),
        expectedObservation: preview.observation!,
        controlledMaintenance: true,
      }),
    ).rejects.toThrow("symlink aliases");
    expect(await fs.readdir(outside)).toEqual([]);
    expect((await service.inventory()).relocations).toEqual([]);
  });

  it("retains locked and nested-repository checkouts", async () => {
    const record = await service.create({ repoRoot: repo, name: "busy", baseRef: "HEAD" });
    await service.acquire(record.id);
    expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
      "locked",
    );
    await service.release(record.id);
    await fs.mkdir(path.join(record.path, "nested", ".git"), { recursive: true });
    expect((await service.previewMove({ id: record.id, destinationRoot })).blockers[0]).toContain(
      "Nested repositories",
    );
  });

  it("inventories unavailable paths without retirement and filters the stored owner", async () => {
    const first = await service.create({ repoRoot: repo, name: "first", baseRef: "HEAD" });
    const second = {
      ...first,
      id: randomUUID(),
      name: "second",
      path: path.join(root, "unavailable", "second"),
      ownerKind: "session" as const,
      ownerId: "agent:main:other",
    };
    insertRegistryWorktree(env, second);
    const inventory = await service.inventory({ ownerKind: "session", ownerId: second.ownerId });
    expect(inventory.worktrees).toEqual([second]);
    expect(inventory.repositories).toEqual([{ path: repo, relocation: "subsequent-phase" }]);
    expect(
      (await service.inventory()).worktrees.find((row) => row.id === second.id)?.removedAt,
    ).toBeUndefined();
  });

  it("does not create state during an empty inventory", async () => {
    expect((await service.inventory()).worktrees).toEqual([]);
    expect(await readWorktreeMoveReceipts(env)).toEqual([]);
    expect(await readManagedWorktreeBackupInventory(env)).toEqual({
      roots: [],
      revision: "missing",
    });
    await expect(fs.lstat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
