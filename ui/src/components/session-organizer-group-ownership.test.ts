// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SessionCapability } from "../lib/sessions/session-capability.ts";
import { sessionMutationGatewayHello } from "../test-helpers/gateway-methods.ts";
import type {
  SidebarRecentSession,
  SidebarSessionMutationScope,
} from "./app-sidebar-session-types.ts";
import { showInputDialog } from "./input-dialog.ts";
import { showSessionGroupDefaultsDialog } from "./session-group-defaults-dialog.ts";
import {
  SessionOrganizerController,
  type SessionOrganizerControllerHost,
} from "./session-organizer-controller.ts";

vi.mock("./input-dialog.ts", () => ({ showInputDialog: vi.fn() }));
vi.mock("./session-group-defaults-dialog.ts", () => ({ showSessionGroupDefaultsDialog: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function harness() {
  let agentId = "alpha";
  let epoch = 1;
  const groupsPut = vi.fn(async () => "completed" as const);
  const groupsRename = vi.fn(async () => "completed" as const);
  const groupsUpdate = vi.fn(async () => "completed" as const);
  const patch = vi.fn(async (key: string) => ({ key, ok: true, entry: { sessionId: "row-id" } }));
  const sessions = {
    groupsPut,
    groupsRename,
    groupsUpdate,
    patch,
    state: { groups: [], error: null },
  } as unknown as SessionCapability;
  const client = {};
  const gateway = {
    snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() },
  };
  const context = {};
  const host = {
    requestUpdate: vi.fn(),
    sessionGroupPresentationOwner: () => agentId,
    knownSessionGroups: () => [],
    knownSectionOrder: () => [],
    knownSessionCatalogIds: () => [],
    sessionGroupDefaults: () => ({ cwd: "/workspace/" + agentId, worktree: false }),
    listSessionGroupFolders: vi.fn(),
    inspectSessionGroupRepository: vi.fn(),
    pruneSidebarSessionEntry: vi.fn(),
    sidebarSessionStatusFilter: () => "active",
    sessionData: {
      beginSessionMutation: (target = agentId) => ({
        epoch,
        selectedAgentId: target,
        sessions,
        gateway,
        client,
        context,
      }),
      isSessionMutationScopeCurrent: (scope: SidebarSessionMutationScope) => scope.epoch === epoch,
      publishSessionMutationError: vi.fn(),
      refreshSidebarSessions: vi.fn(),
    },
  } as unknown as SessionOrganizerControllerHost;
  return {
    controller: new SessionOrganizerController(host),
    host,
    groupsPut,
    groupsRename,
    groupsUpdate,
    patch,
    select: (id: string) => {
      agentId = id;
      epoch += 1;
    },
  };
}

describe("group action owners", () => {
  it("does not capture a new agent after a rename dialog returns, including A -> B -> A", async () => {
    const h = harness();
    const name = createDeferred<string | null>();
    vi.mocked(showInputDialog).mockReturnValue(name.promise);
    const action = h.controller.renameSessionGroupFromMenu("Shared");
    await vi.waitFor(() => expect(showInputDialog).toHaveBeenCalledOnce());
    h.select("beta");
    h.select("alpha");
    name.resolve("Renamed");
    await action;
    expect(h.groupsRename).not.toHaveBeenCalled();
  });

  it("does not retarget defaults when the owner changes while the dialog is open", async () => {
    const h = harness();
    let submit: Parameters<typeof showSessionGroupDefaultsDialog>[0]["submit"] | undefined;
    vi.mocked(showSessionGroupDefaultsDialog).mockImplementation(async (options) => {
      submit = options.submit;
    });
    await h.controller.editSessionGroupDefaults("Shared");
    expect(showSessionGroupDefaultsDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaults: { cwd: "/workspace/alpha", worktree: false } }),
    );
    h.select("beta");
    h.select("alpha");
    expect(submit).toBeTypeOf("function");
    expect(await submit?.({ cwd: "/new", worktree: true })).toBeTypeOf("string");
    expect(h.groupsUpdate).not.toHaveBeenCalled();
  });

  it("keeps a new group bound before the input dialog's first await", async () => {
    const h = harness();
    let submit: Parameters<typeof showInputDialog>[0]["submit"];
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      submit = options.submit;
      return null;
    });
    await h.controller.createSessionGroup();
    h.select("beta");
    h.select("alpha");
    expect(submit).toBeTypeOf("function");
    expect(await submit?.("Never retarget")).toBeTypeOf("string");
    expect(h.groupsPut).not.toHaveBeenCalled();
  });

  it("appends to the clicked roster row's agent rather than the foreground", async () => {
    const h = harness();
    vi.mocked(showInputDialog).mockImplementation(async (options) => {
      await options.submit?.("Research");
      return "Research";
    });
    await h.controller.createSessionGroup([
      {
        key: "agent:beta:row",
        agentId: "beta",
        sessionId: "row-id",
        label: "Research row",
        pinned: false,
        active: false,
      } as SidebarRecentSession,
    ]);
    expect(h.groupsPut).toHaveBeenCalledWith(["Research"], undefined, "beta", true);
    expect(h.patch).toHaveBeenCalledWith(
      "agent:beta:row",
      { category: "Research" },
      expect.objectContaining({ agentId: "beta", expectedSessionId: "row-id" }),
    );
  });
});
