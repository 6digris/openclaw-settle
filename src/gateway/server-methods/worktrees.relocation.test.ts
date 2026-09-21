import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "../server-methods.js";
import { createWorktreesHandlers } from "./worktrees.js";

const move = {
  id: "owned-worktree",
  destinationRoot: "/srv/workspaces",
  operationId: "f62d371a-9e70-4a4f-8f6d-48952f142f98",
  expectedObservation: "a".repeat(64),
  controlledMaintenance: true,
};

type DispatchOptions = {
  scopes: string[];
  plugin?: boolean;
  hasCurrentClientAuthority?: () => boolean;
  sessionMutationCommitGuard?: () => void;
};

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  service: Parameters<typeof createWorktreesHandlers>[0],
  options: DispatchOptions,
) {
  const respond = vi.fn();
  let failure: unknown;
  await handleGatewayRequest({
    req: { type: "req", id: "workspace-test", method, params },
    respond,
    client: {
      connId: "workspace-test",
      connect: {
        role: "operator",
        scopes: options.scopes,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
        minProtocol: 1,
        maxProtocol: 1,
      },
      ...(options.plugin ? { internal: { pluginRuntimeOwnerId: "test-plugin" } } : {}),
    } as Parameters<typeof handleGatewayRequest>[0]["client"],
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
    extraHandlers: createWorktreesHandlers(service),
    hasCurrentClientAuthority: options.hasCurrentClientAuthority,
    sessionMutationCommitGuard: options.sessionMutationCommitGuard,
  }).catch((error: unknown) => {
    failure = error;
  });
  return { respond, failure };
}

describe("native workspace relocation authorization", () => {
  it.each([
    ["worktrees.inventory", {}],
    ["worktrees.move.preview", { id: move.id, destinationRoot: move.destinationRoot }],
    ["worktrees.move", move],
    ["worktrees.move.verify", { operationId: move.operationId }],
  ] as const)("keeps %s admin-only for ordinary and plugin dispatch", async (method, params) => {
    const service = {
      inventory: vi.fn(),
      previewMove: vi.fn(),
      move: vi.fn(),
      verifyMove: vi.fn(),
    };
    for (const plugin of [false, true]) {
      const { respond, failure } = await dispatch(method, params, service as never, {
        scopes: ["operator.read", "operator.write"],
        plugin,
      });
      expect(failure).toBeUndefined();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        }),
      );
    }
    expect(
      Object.values(service).every((serviceMethod) => serviceMethod.mock.calls.length === 0),
    ).toBe(true);
  });

  it("allows a current administrator to inspect one stored owner through the normal method", async () => {
    const inventory = vi.fn(async () => ({ worktrees: [], relocations: [], projections: [] }));
    const owner = { ownerKind: "session", ownerId: "agent:main:task" };
    const { respond, failure } = await dispatch(
      "worktrees.inventory",
      { owner },
      { inventory } as never,
      {
        scopes: ["operator.admin"],
        plugin: true,
        hasCurrentClientAuthority: () => true,
      },
    );
    expect(failure).toBeUndefined();
    expect(inventory).toHaveBeenCalledWith(owner);
    expect(respond).toHaveBeenCalledWith(
      true,
      { worktrees: [], relocations: [], projections: [] },
      undefined,
    );
  });

  it("does not disclose a prepared inventory after requester revocation", async () => {
    let current = true;
    const inventory = vi.fn(async () => {
      current = false;
      return { worktrees: ["private-path"] };
    });
    const { respond, failure } = await dispatch("worktrees.inventory", {}, { inventory } as never, {
      scopes: ["operator.admin"],
      hasCurrentClientAuthority: () => current,
    });
    expect(failure).toBeInstanceOf(Error);
    expect(inventory).toHaveBeenCalledOnce();
    expect(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
  });

  it("carries the original in-process authority to the filesystem admission boundary", async () => {
    let current = true;
    const effect = vi.fn();
    const mover = vi.fn(async (_params, guard: { commitGuard: () => void }) => {
      current = false;
      guard.commitGuard();
      effect();
    });
    const { respond, failure } = await dispatch("worktrees.move", move, { move: mover } as never, {
      scopes: ["operator.admin"],
      plugin: true,
      sessionMutationCommitGuard: () => {
        if (!current) {
          throw new Error("Request owner revoked");
        }
      },
    });
    expect(failure).toBeInstanceOf(Error);
    expect(mover).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    expect(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
  });

  it("rejects a move without explicit controlled maintenance", async () => {
    const mover = vi.fn();
    const { respond, failure } = await dispatch(
      "worktrees.move",
      { ...move, controlledMaintenance: false },
      { move: mover } as never,
      { scopes: ["operator.admin"] },
    );
    expect(mover).not.toHaveBeenCalled();
    expect(failure).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});
