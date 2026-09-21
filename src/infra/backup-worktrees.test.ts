import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ManagedWorktreeService } from "../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../agents/worktrees/service.test-support.js";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { resolveBackupPlanFromDisk } from "../commands/backup-shared.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { withLocalWorkspaceProjection } from "../gateway/worker-environments/local-workspace-projection.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";

describe("managed workspace backup coverage", () => {
  it("stages Git owner, external checkout, private projection and canonical registry together", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", prefix: "backup-managed-worktrees-" },
      async (state) => {
        const root = await fs.realpath(state.root);
        const repo = await initializeManagedWorktreeTestRepository(root);
        const worktreeRoot = path.join(root, "external-workspaces");
        const config = { worktreeRoot, worktreeAcceleration: false };
        await state.writeConfig(config);
        const service = new ManagedWorktreeService({ env: process.env, getConfig: () => config });
        const sessionKey = "agent:main:backup-test";
        const record = await service.create({
          repoRoot: repo,
          name: "durable",
          baseRef: "HEAD",
          ownerKind: "session",
          ownerId: sessionKey,
        });
        const projection = await withLocalWorkspaceProjection(
          {
            worktree: record,
            worktreeRoot,
            agentId: "main",
            sessionKey,
            sessionId: randomUUID(),
            lifecycleRevision: null,
            assertCurrent: () => {},
          },
          (workspace) => workspace.prepare(),
        );
        await fs.writeFile(path.join(record.path, "untracked.txt"), "canonical pending edit\n");
        await fs.writeFile(path.join(projection, "pending.txt"), "private pending edit\n");
        const excluded = await resolveBackupPlanFromDisk({ includeWorkspace: false });
        expect(excluded.included.filter((asset) => asset.kind === "workspace")).toEqual([]);

        const archive = await createBackupArchive({
          output: state.path("managed.tar.gz"),
          includeWorkspace: true,
        });
        const roots = [repo, record.path, projection];
        for (const sourcePath of roots) {
          expect(archive.assets).toContainEqual(
            expect.objectContaining({ kind: "workspace", sourcePath }),
          );
        }
        await expect(verifyBackupArchive(archive.archivePath)).resolves.toMatchObject({ ok: true });
        const target = state.path("restore-staging");
        await backupRestoreCommand(
          { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          { archive: archive.archivePath, target },
        );
        const restored = (source: string, relative: string) => {
          const asset = archive.assets.find((entry) => entry.sourcePath === source);
          if (!asset) {
            throw new Error("Missing managed workspace archive asset");
          }
          return path.join(target, asset.archivePath, relative);
        };
        expect(await fs.readFile(restored(record.path, "untracked.txt"), "utf8")).toBe(
          "canonical pending edit\n",
        );
        expect(await fs.readFile(restored(projection, "pending.txt"), "utf8")).toBe(
          "private pending edit\n",
        );
        expect(await fs.readFile(restored(record.path, ".git"), "utf8")).toBe(
          await fs.readFile(path.join(record.path, ".git"), "utf8"),
        );
        expect(await fs.readFile(restored(repo, ".git/HEAD"), "utf8")).toBe(
          await fs.readFile(path.join(repo, ".git/HEAD"), "utf8"),
        );
        expect(archive.assets).toContainEqual(
          expect.objectContaining({ kind: "state", sourcePath: await fs.realpath(state.stateDir) }),
        );
        expect((await service.inventory()).worktrees[0]?.path).toBe(record.path);
      },
    );
  });
});
