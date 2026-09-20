import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLifecycleBinding } from "../../agents/agent-lifecycle-registry.js";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const groupMocks = vi.hoisted(() => ({
  NotEmpty: class SessionGroupNotEmptyError extends Error {},
  NotFound: class SessionGroupNotFoundError extends Error {},
  list: vi.fn(() => []),
  defaults: vi.fn(() => []),
  order: vi.fn(() => []),
  delete: vi.fn(),
  put: vi.fn(),
  rename: vi.fn(),
  update: vi.fn(),
}));
const lifecycleMocks = vi.hoisted(() => ({
  capture:
    vi.fn<typeof import("../../agents/agent-lifecycle-registry.js").captureAgentLifecycleBinding>(),
  matches:
    vi.fn<typeof import("../../agents/agent-lifecycle-registry.js").matchesAgentLifecycleBinding>(),
}));

vi.mock("../../agents/agent-lifecycle-registry.js", () => ({
  captureAgentLifecycleBinding: lifecycleMocks.capture,
  matchesAgentLifecycleBinding: lifecycleMocks.matches,
}));

const pathMocks = vi.hoisted(() => ({
  isCurrent: vi.fn(),
  resolveContainment: vi.fn(),
}));

vi.mock("../session-groups.js", () => ({
  deleteSessionGroup: groupMocks.delete,
  listSessionGroupDefaults: groupMocks.defaults,
  listSessionGroups: groupMocks.list,
  listSidebarSectionOrder: groupMocks.order,
  putSessionGroups: groupMocks.put,
  renameSessionGroup: groupMocks.rename,
  resolveSessionGroupMutationTargetsByName: vi.fn(() => new Map()),
  SessionGroupNotEmptyError: groupMocks.NotEmpty,
  SessionGroupNotFoundError: groupMocks.NotFound,
  updateSessionGroupDefaults: groupMocks.update,
}));
vi.mock("./workspace-path-containment.js", () => ({
  isWorkspacePathContainmentCurrent: pathMocks.isCurrent,
  resolveWorkspacePathContainment: pathMocks.resolveContainment,
}));

import { sessionGroupHandlers } from "./sessions-groups.js";

beforeEach(() => {
  // The RPC unit fixture has no durable lifecycle store. Keep its exact captured
  // binding while using the production roster resolver, including implicit main.
  const bindings = new Map<string, AgentLifecycleBinding>();
  lifecycleMocks.capture.mockReset().mockImplementation((cfg, agentId) => {
    if (!resolveAgentConfig(cfg, agentId)) {
      return undefined;
    }
    const binding = Object.freeze({ agentId, provenance: null });
    bindings.set(agentId, binding);
    return binding;
  });
  lifecycleMocks.matches
    .mockReset()
    .mockImplementation(
      (cfg, binding) =>
        Boolean(resolveAgentConfig(cfg, binding.agentId)) &&
        bindings.get(binding.agentId) === binding,
    );
});

function updateOptions(
  params: Record<string, unknown>,
  respond: ReturnType<typeof vi.fn>,
  scopes = ["operator.write", "operator.admin"],
) {
  return {
    params,
    respond,
    client: { connect: { scopes } },
    context: {
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

function renameOptions(params: Record<string, unknown>, respond: ReturnType<typeof vi.fn>) {
  return {
    params,
    respond,
    context: {
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
    },
  } as unknown as GatewayRequestHandlerOptions;
}

describe("sessions.groups.put", () => {
  beforeEach(() => {
    groupMocks.put.mockReset();
  });

  it("rejects dropping a non-empty group as an invalid request", async () => {
    const message = "cannot drop Gone; remove it via sessions.groups.delete";
    groupMocks.put.mockImplementation(() => {
      throw new groupMocks.NotEmpty(message);
    });
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.put"],
      'sessionGroupHandlers["sessions.groups.put"] test invariant',
    )(updateOptions({ names: ["Keep"] }, respond));

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message }),
    );
  });

  it("replaces the catalog using the runtime config and authorization guards", async () => {
    const cfg = { agents: { list: [{ id: "main" }] } };
    const names = ["Keep"];
    const sectionOrder = ["category:Keep", "ungrouped"];
    const groups = [{ name: "Keep", position: 0 }];
    groupMocks.put.mockReturnValue(groups);
    const respond = vi.fn();
    const options = updateOptions({ names, sectionOrder }, respond);
    options.context.getRuntimeConfig = () => cfg;
    const assertCurrent = vi.fn();
    const assertTargetCurrent = vi.fn();
    options.sessionMutationAuthorization = { assertCurrent, assertTargetCurrent };

    await expectDefined(
      sessionGroupHandlers["sessions.groups.put"],
      'sessionGroupHandlers["sessions.groups.put"] test invariant',
    )(options);

    expect(groupMocks.put).toHaveBeenCalledExactlyOnceWith({
      cfg,
      agentId: "main",
      append: undefined,
      importId: undefined,
      names,
      sectionOrder,
      assertCurrent: expect.any(Function),
      assertTargetCurrent,
    });
    groupMocks.put.mock.calls[0]?.[0].assertCurrent();
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(groupMocks.put.mock.calls[0]?.[0].cfg).toBe(cfg);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, groups, sectionOrder: [] }, undefined);
  });

  it("rethrows changed authorization instead of mapping it to an unavailable response", async () => {
    const error = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed before sessions.groups.put; retry the request",
    });
    groupMocks.put.mockImplementation(() => {
      throw error;
    });
    const respond = vi.fn();
    await expect(
      expectDefined(
        sessionGroupHandlers["sessions.groups.put"],
        'sessionGroupHandlers["sessions.groups.put"] test invariant',
      )(updateOptions({ names: [] }, respond)),
    ).rejects.toBe(error);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe("sessions.groups.update", () => {
  beforeEach(() => {
    groupMocks.update.mockReset();
    pathMocks.isCurrent.mockReset();
    pathMocks.isCurrent.mockReturnValue(true);
    pathMocks.resolveContainment.mockReset();
  });

  it("rejects a relative cwd before mutating defaults", async () => {
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(updateOptions({ name: "Travel", cwd: "tmp/travel", worktree: false }, respond));

    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects a stale target without recreating it", async () => {
    groupMocks.update.mockReturnValue(null);
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(updateOptions({ name: "Travel", cwd: "/tmp/travel", worktree: true }, respond));

    expect(groupMocks.update).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown session group: Travel",
      }),
    );
  });

  it("rejects a non-admin cwd outside configured workspaces", async () => {
    pathMocks.resolveContainment.mockResolvedValue(null);
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(
      updateOptions({ name: "Travel", cwd: "/outside/travel", worktree: false }, respond, [
        "operator.write",
      ]),
    );

    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
    );
  });

  it("persists the canonical workspace-contained cwd for a write caller", async () => {
    pathMocks.resolveContainment.mockResolvedValue({
      path: "/workspace/client",
      workspaceRoot: "/workspace",
    });
    groupMocks.update.mockReturnValue([
      { name: "Client", cwd: "/workspace/client", worktree: true },
    ]);
    const respond = vi.fn();
    const assertCurrent = vi.fn();
    const options = updateOptions(
      { name: "Client", cwd: "/workspace/link", worktree: true },
      respond,
      ["operator.write"],
    );
    options.sessionMutationAuthorization = {
      assertCurrent,
      assertTargetCurrent: vi.fn(),
    };
    await expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(options);

    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(groupMocks.update).toHaveBeenCalledWith(
      "main",
      "Client",
      {
        cwd: "/workspace/client",
        worktree: true,
      },
      process.env,
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        defaults: [{ name: "Client", cwd: "/workspace/client", worktree: true }],
      },
      undefined,
    );
  });

  it("rejects containment retired by a runtime config change before commit", async () => {
    const containment = {
      path: "/workspace/client",
      workspaceRoot: "/workspace",
    };
    let finishContainment: ((value: typeof containment) => void) | undefined;
    pathMocks.resolveContainment.mockImplementation(
      async () =>
        await new Promise<typeof containment>((resolve) => {
          finishContainment = resolve;
        }),
    );
    const initialConfig = { agents: { defaults: { workspace: "/workspace" } } };
    const retiredConfig = { agents: { defaults: { workspace: "/replacement" } } };
    let runtimeConfig = initialConfig;
    pathMocks.isCurrent.mockImplementation((_containment, cfg) => cfg === initialConfig);
    const respond = vi.fn();
    const options = updateOptions(
      { name: "Client", cwd: "/workspace/client", worktree: true },
      respond,
      ["operator.write"],
    );
    options.context.getRuntimeConfig = () => runtimeConfig;
    const update = expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      'sessionGroupHandlers["sessions.groups.update"] test invariant',
    )(options);

    await vi.waitFor(() => expect(pathMocks.resolveContainment).toHaveBeenCalledOnce());
    runtimeConfig = retiredConfig;
    finishContainment?.(containment);
    await update;

    expect(pathMocks.isCurrent).toHaveBeenCalledWith(containment, retiredConfig);
    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("operator.admin") }),
    );
  });
});

describe("sessions.groups.rename", () => {
  beforeEach(() => {
    groupMocks.rename.mockReset();
  });

  it("rejects an unknown source group", async () => {
    groupMocks.rename.mockRejectedValue(new groupMocks.NotFound("unknown session group: Missing"));
    const respond = vi.fn();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.rename"],
      'sessionGroupHandlers["sessions.groups.rename"] test invariant',
    )(renameOptions({ name: "Missing", to: "Other" }, respond));

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "unknown session group: Missing",
      }),
    );
  });
});

describe("session group RPC agent ownership", () => {
  const methods = [
    { method: "sessions.groups.list", params: {} },
    { method: "sessions.groups.defaults", params: {} },
    { method: "sessions.groups.put", params: { names: ["Shared"] } },
    { method: "sessions.groups.rename", params: { name: "Shared", to: "Renamed" } },
    { method: "sessions.groups.delete", params: { name: "Shared" } },
    { method: "sessions.groups.update", params: { name: "Shared", cwd: null, worktree: false } },
  ];
  const multi: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { alpha: {}, beta: {} },
      defaults: { systemAgent: { agentId: "alpha" } },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    groupMocks.put.mockReset().mockReturnValue([]);
    groupMocks.rename
      .mockReset()
      .mockResolvedValue({ groups: [], sectionOrder: [], updatedSessions: 0 });
    groupMocks.delete
      .mockReset()
      .mockResolvedValue({ groups: [], sectionOrder: [], updatedSessions: 0 });
    groupMocks.update.mockReset().mockReturnValue([]);
  });

  it.each(methods)(
    "permits an omitted owner only for a sole configured agent: $method",
    async ({ method, params }) => {
      const respond = vi.fn();
      const options = updateOptions(params, respond);
      options.context.getRuntimeConfig = () => ({
        agents: { ownership: "explicit", entries: { beta: {} } },
      });
      await expectDefined(sessionGroupHandlers[method], "group handler")(options);
      expect(respond).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      if (method === "sessions.groups.list") {
        expect(groupMocks.list).toHaveBeenCalledWith("beta");
        expect(groupMocks.order).toHaveBeenCalledWith("beta");
      } else if (method === "sessions.groups.defaults") {
        expect(groupMocks.defaults).toHaveBeenCalledWith("beta");
      } else if (method === "sessions.groups.update") {
        expect(groupMocks.update).toHaveBeenCalledWith(
          "beta",
          "Shared",
          { cwd: null, worktree: false },
          process.env,
          expect.any(Function),
        );
      } else {
        const operation =
          method === "sessions.groups.put"
            ? groupMocks.put
            : method === "sessions.groups.rename"
              ? groupMocks.rename
              : groupMocks.delete;
        expect(operation).toHaveBeenCalledWith(expect.objectContaining({ agentId: "beta" }));
      }
    },
  );

  it.each(
    methods.flatMap((entry) =>
      [undefined, "unknown", "*"].map((agentId) => ({
        method: entry.method,
        params: entry.params,
        agentId,
      })),
    ),
  )(
    "rejects ambiguous or unknown owner $agentId for $method without reading or writing a catalog",
    async ({ method, params, agentId }) => {
      const respond = vi.fn();
      const options = updateOptions(
        { ...params, ...(agentId === undefined ? {} : { agentId }) },
        respond,
      );
      options.context.getRuntimeConfig = () => multi;
      await expectDefined(sessionGroupHandlers[method], "group handler")(options);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      for (const operation of [
        groupMocks.list,
        groupMocks.defaults,
        groupMocks.order,
        groupMocks.put,
        groupMocks.rename,
        groupMocks.delete,
        groupMocks.update,
      ]) {
        expect(operation).not.toHaveBeenCalled();
      }
    },
  );

  it("passes migration identity only for append and refuses replacement before mutation", async () => {
    const respond = vi.fn();
    const input = {
      agentId: "beta",
      names: ["Imported"],
      append: true,
      importId: "stable-source-id",
    };
    const options = updateOptions(input, respond);
    options.context.getRuntimeConfig = () => multi;
    const handler = expectDefined(sessionGroupHandlers["sessions.groups.put"], "put handler");
    await handler(options);
    expect(groupMocks.put).toHaveBeenCalledWith(expect.objectContaining(input));
    groupMocks.put.mockClear();
    respond.mockClear();
    await handler({ ...options, params: { ...input, append: false } });
    expect(groupMocks.put).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("passes append through without replacing section order", async () => {
    const respond = vi.fn();
    const options = updateOptions({ agentId: "beta", names: ["Imported"], append: true }, respond);
    options.context.getRuntimeConfig = () => multi;
    await expectDefined(sessionGroupHandlers["sessions.groups.put"], "put handler")(options);
    expect(groupMocks.put).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "beta",
        names: ["Imported"],
        append: true,
        sectionOrder: undefined,
      }),
    );
    groupMocks.put.mockClear();
    respond.mockClear();
    await expectDefined(
      sessionGroupHandlers["sessions.groups.put"],
      "put handler",
    )({
      ...options,
      params: { agentId: "beta", names: ["Rejected"], append: true, sectionOrder: [] },
    });
    expect(groupMocks.put).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("rejects an owner retired during awaited workspace containment rather than retargeting defaults", async () => {
    let cfg = multi;
    let finish: ((value: { path: string; workspaceRoot: string }) => void) | undefined;
    pathMocks.resolveContainment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    pathMocks.isCurrent.mockReturnValue(true);
    const respond = vi.fn();
    const options = updateOptions(
      { agentId: "beta", name: "Shared", cwd: "/workspace/beta", worktree: true },
      respond,
      ["operator.write"],
    );
    options.context.getRuntimeConfig = () => cfg;
    const pending = expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      "update handler",
    )(options);
    expect(pathMocks.resolveContainment).toHaveBeenCalledOnce();
    cfg = { agents: { ownership: "explicit", entries: { alpha: {} } } };
    finish?.({ path: "/workspace/beta", workspaceRoot: "/workspace" });
    await expect(pending).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("binds a sole-owner legacy update before its first await rather than following a replacement sole owner", async () => {
    let cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { beta: {} } } };
    let finish: ((value: { path: string; workspaceRoot: string }) => void) | undefined;
    pathMocks.resolveContainment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    pathMocks.isCurrent.mockReturnValue(true);
    const respond = vi.fn();
    const options = updateOptions(
      { name: "Shared", cwd: "/workspace/beta", worktree: true },
      respond,
      ["operator.write"],
    );
    options.context.getRuntimeConfig = () => cfg;
    const pending = expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      "update handler",
    )(options);
    cfg = { agents: { ownership: "explicit", entries: { alpha: {} } } };
    finish?.({ path: "/workspace/beta", workspaceRoot: "/workspace" });
    await expect(pending).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
    expect(groupMocks.update).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("captures the exact lifecycle before containment and reuses it after the await and inside commit", async () => {
    let finish: ((value: { path: string; workspaceRoot: string }) => void) | undefined;
    pathMocks.resolveContainment.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    pathMocks.isCurrent.mockReturnValue(true);
    const respond = vi.fn();
    const authority = vi.fn();
    const options = updateOptions(
      { agentId: "beta", name: "Shared", cwd: "/workspace/beta", worktree: true },
      respond,
      ["operator.write"],
    );
    options.context.getRuntimeConfig = () => multi;
    options.sessionMutationAuthorization = {
      assertCurrent: authority,
      assertTargetCurrent: vi.fn(),
    };
    groupMocks.update.mockImplementation((_agentId, _name, _defaults, _env, assertCurrent) => {
      assertCurrent();
      return [];
    });
    const pending = expectDefined(
      sessionGroupHandlers["sessions.groups.update"],
      "update handler",
    )(options);
    expect(lifecycleMocks.capture).toHaveBeenCalledExactlyOnceWith(multi, "beta");
    expect(pathMocks.resolveContainment).toHaveBeenCalledOnce();
    expect(lifecycleMocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        pathMocks.resolveContainment.mock.invocationCallOrder[0],
        "containment invocation",
      ),
    );
    const captured = expectDefined(
      lifecycleMocks.capture.mock.results[0]?.value,
      "captured binding",
    );
    finish?.({ path: "/workspace/beta", workspaceRoot: "/workspace" });
    await pending;
    expect(lifecycleMocks.capture).toHaveBeenCalledOnce();
    expect(lifecycleMocks.matches).toHaveBeenCalledTimes(2);
    for (const [, binding] of lifecycleMocks.matches.mock.calls) {
      expect(binding).toBe(captured);
    }
    expect(authority).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledWith(true, { ok: true, defaults: [] }, undefined);
  });

  it("carries the captured owner check into the defaults commit guard", async () => {
    let cfg = multi;
    const respond = vi.fn();
    const options = updateOptions(
      { agentId: "beta", name: "Shared", cwd: null, worktree: false },
      respond,
    );
    options.context.getRuntimeConfig = () => cfg;
    groupMocks.update.mockImplementation((_agentId, _name, _defaults, _env, assertCurrent) => {
      cfg = { agents: { ownership: "explicit", entries: { alpha: {} } } };
      assertCurrent();
      return [];
    });
    await expect(
      expectDefined(sessionGroupHandlers["sessions.groups.update"], "update handler")(options),
    ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
    expect(respond).not.toHaveBeenCalled();
  });

  it("carries an owner guard to the put transaction instead of checking only at RPC admission", async () => {
    let cfg = multi;
    const respond = vi.fn();
    const options = updateOptions({ agentId: "beta", names: ["Shared"] }, respond);
    options.context.getRuntimeConfig = () => cfg;
    groupMocks.put.mockImplementation(({ assertCurrent }) => {
      cfg = { agents: { ownership: "explicit", entries: { alpha: {} } } };
      assertCurrent();
      return [];
    });
    await expect(
      expectDefined(sessionGroupHandlers["sessions.groups.put"], "put handler")(options),
    ).rejects.toBeInstanceOf(SessionMutationAuthorizationChangedError);
    expect(respond).not.toHaveBeenCalled();
  });
});
