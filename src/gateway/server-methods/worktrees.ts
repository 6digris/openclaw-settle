import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateWorktreesBranchesParams,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesListParams,
  validateWorktreesInventoryParams,
  validateWorktreesMovePreviewParams,
  validateWorktreesMoveParams,
  validateWorktreesMoveVerifyParams,
  validateWorktreesRemoveParams,
  validateWorktreesRestoreParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createManagedWorktreeOwnerPolicy } from "../../agents/worktrees/owner-protection.js";
import {
  managedWorktrees,
  resolveWorktreeCleanupLimits,
  WorktreeSnapshotError,
} from "../../agents/worktrees/service.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { resolveRecordedProjectRoot } from "../../projects/project-registry.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

type WorktreeService = Pick<
  ManagedWorktreeService,
  | "create"
  | "gc"
  | "list"
  | "listRepositoryBranches"
  | "remove"
  | "restore"
  | "inventory"
  | "previewMove"
  | "move"
  | "verifyMove"
>;

function invalidParams(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"]): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid worktrees parameters"));
}

function workspaceAdminGuard(options: Parameters<GatewayRequestHandlers[string]>[0]): () => void {
  const authority = readGatewayRequestMutationAuthority(options);
  const guard = () => {
    authority.assertCurrent();
    if (!options.client?.connect.scopes?.includes(ADMIN_SCOPE)) {
      throw new Error(
        "Workspace inventory and relocation require current operator.admin authority",
      );
    }
  };
  guard();
  return guard;
}

async function resolveAuthorizedRepoRoot(
  method: string,
  repoRoot: string,
  opts: Parameters<GatewayRequestHandlers[string]>[0],
): Promise<string | undefined> {
  const scopes = Array.isArray(opts.client?.connect.scopes) ? opts.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return repoRoot;
  }
  const containment = await resolveWorkspacePathContainment(
    repoRoot,
    opts.context.getRuntimeConfig(),
  );
  // A stored project row authorizes its canonical repo root for write-scoped clients.
  const authorizedRoot = containment?.path ?? (await resolveRecordedProjectRoot(repoRoot));
  if (authorizedRoot) {
    return authorizedRoot;
  }
  opts.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `${method} outside configured agent workspaces requires gateway scope: ${ADMIN_SCOPE}`,
    ),
  );
  return undefined;
}

export function createWorktreesHandlers(service: WorktreeService): GatewayRequestHandlers {
  return {
    "worktrees.inventory": async (options) => {
      const { params, respond } = options;
      if (!validateWorktreesInventoryParams(params)) {
        return invalidParams(respond);
      }
      const assertCurrent = workspaceAdminGuard(options);
      const result = await service.inventory(params.owner);
      assertCurrent();
      respond(true, result, undefined);
    },
    "worktrees.move.preview": async (options) => {
      const { params, respond } = options;
      if (!validateWorktreesMovePreviewParams(params)) {
        return invalidParams(respond);
      }
      const assertCurrent = workspaceAdminGuard(options);
      const result = await service.previewMove(params);
      assertCurrent();
      respond(true, result, undefined);
    },
    "worktrees.move": async (options) => {
      const { params, respond } = options;
      if (!validateWorktreesMoveParams(params)) {
        return invalidParams(respond);
      }
      const assertCurrent = workspaceAdminGuard(options);
      const result = await service.move(params, {
        commitGuard: assertCurrent,
        signal: options.signal,
      });
      assertCurrent();
      respond(true, result, undefined);
    },
    "worktrees.move.verify": async (options) => {
      const { params, respond } = options;
      if (!validateWorktreesMoveVerifyParams(params)) {
        return invalidParams(respond);
      }
      const assertCurrent = workspaceAdminGuard(options);
      const result = await service.verifyMove(params.operationId);
      assertCurrent();
      respond(true, result, undefined);
    },
    "worktrees.list": async ({ params, respond }) => {
      if (!validateWorktreesListParams(params)) {
        invalidParams(respond);
        return;
      }
      respond(true, { worktrees: await service.list() }, undefined);
    },
    "worktrees.create": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesCreateParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("worktrees.create", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const scopes = Array.isArray(opts.client?.connect.scopes) ? opts.client.connect.scopes : [];
      respond(
        true,
        await service.create({
          repoRoot,
          name: params.name,
          baseRef: params.baseRef,
          ownerKind: "manual",
          // Repository hooks and .openclaw/worktree-setup.sh execute repo code.
          runSetupScript: scopes.includes(ADMIN_SCOPE),
        }),
        undefined,
      );
    },
    "worktrees.remove": async ({ params, respond }) => {
      if (!validateWorktreesRemoveParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        const result = await service.remove({
          id: normalizeOptionalString(params.id) ?? params.id,
          reason: "manual-delete",
          allowSnapshotLoss: params.force,
        });
        respond(
          true,
          {
            removed: result.removed,
            ...(result.snapshotRef ? { snapshotRef: result.snapshotRef } : {}),
            ...(result.snapshotError ? { snapshotError: result.snapshotError } : {}),
          },
          undefined,
        );
      } catch (error) {
        // Snapshot failures are a structured outcome: clients decide whether
        // to retry with force instead of sniffing error strings.
        if (error instanceof WorktreeSnapshotError) {
          respond(true, { removed: false, snapshotError: error.snapshotError }, undefined);
          return;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.restore": async ({ params, respond }) => {
      if (!validateWorktreesRestoreParams(params)) {
        invalidParams(respond);
        return;
      }
      const id = normalizeOptionalString(params.id) ?? params.id;
      respond(true, await service.restore({ id }), undefined);
    },
    "worktrees.branches": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesBranchesParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("worktrees.branches", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = params.includeRepositoryStatus
        ? await service.listRepositoryBranches(repoRoot, {
            includeRepositoryStatus: true,
          })
        : await service.listRepositoryBranches(repoRoot);
      respond(true, result, undefined);
    },
    "worktrees.gc": async ({ params, respond, context }) => {
      if (!validateWorktreesGcParams(params)) {
        invalidParams(respond);
        return;
      }
      const cfg = context.getRuntimeConfig();
      const limits = resolveWorktreeCleanupLimits();
      respond(
        true,
        await service.gc({
          limits,
          ...createManagedWorktreeOwnerPolicy(cfg),
        }),
        undefined,
      );
    },
  };
}

export const worktreesHandlers = createWorktreesHandlers(managedWorktrees);
