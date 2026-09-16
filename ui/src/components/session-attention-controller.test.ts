import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import * as approvalPresentation from "../app/approval-presentation.ts";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import { createApplicationOverlays } from "../app/overlays.ts";
import * as questions from "../app/question-prompt.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
} from "../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { buildSidebarSessionNavigationState } from "./app-sidebar-session-navigation-logic.ts";
import { projectSessionTree } from "./app-sidebar-session-tree.ts";
import { SessionAttentionController } from "./session-attention-controller.ts";

const disposals: Array<() => void> = [];
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

function fixture(count = 20, pending = 3) {
  const gateway = createGatewayHarness({
    request: async () => ({ questions: [] }),
  } as unknown as GatewayBrowserClient);
  gateway.publish({
    hello: gatewayHelloForMethods(["question.list", "question.get", "question.resolve"]),
  });
  const keys = Array.from({ length: count }, (_, i) => `agent:main:task-${i}`);
  const approvals: ExecApprovalRequest[] = Array.from({ length: pending }, (_, i) => ({
    id: `approval-${i}`,
    kind: "exec",
    createdAtMs: i + 1,
    expiresAtMs: Date.now() + 60_000,
    request: { command: `pnpm test --filter task-${i}`, sessionKey: keys[i] },
  }));
  const context = createContext(gateway.gateway, createSessions("main", keys), null, approvals);
  const controllers: ReactiveController[] = [];
  const host: ReactiveControllerHost & {
    isConnected: boolean;
    sessionAttentionContext: typeof context;
  } = {
    isConnected: true,
    sessionAttentionContext: context,
    addController: (controller) => {
      controllers.push(controller);
    },
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
  };
  const attention = new SessionAttentionController(host);
  controllers.forEach((controller) => controller.hostConnected?.());
  disposals.push(() => controllers.forEach((controller) => controller.hostDisconnected?.()));
  for (let i = 0; i < pending; i++) {
    gateway.publishEvent("question.requested", {
      id: `question-${i}`,
      status: "pending",
      sessionKey: keys[i],
      createdAtMs: i + 10,
      expiresAtMs: Date.now() + 60_000,
      questions: [
        {
          questionId: "continue_run",
          header: "Continue",
          question: `Continue release task ${i}?`,
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
  }
  const rows: GatewaySessionRow[] = keys.map(
    (key) => ({ key, kind: "direct", updatedAt: 1 }) satisfies GatewaySessionRow,
  );
  const update = () => controllers.forEach((controller) => controller.hostUpdate?.());
  const project = () => {
    const navigation = buildSidebarSessionNavigationState({
      context,
      routeSessionKey: keys[0]!,
      sessionsResult: context.sessions.state.result,
      sessionsAgentId: "main",
      showCron: false,
      showSystem: false,
      statusFilter: "active",
      compareSessions: (a, b) => a.key.localeCompare(b.key),
      highlightCurrentSession: true,
      runtimeSampledAtByRow: new WeakMap(),
      loadingChildSessionKeys: new Set(),
      outboxAttentionCountForSessionKey: () => 0,
      hasSessionDraft: () => false,
      resolveAttention: (row) => attention.resolveSessionAttention(row),
      resolveAgentStatusNote: () => undefined,
    });
    return projectSessionTree({
      roots: rows,
      rowsByKey: new Map(rows.map((row) => [row.key, row])),
      loadingChildKeys: new Set(),
      knownSessionAttention: attention.knownSessionAttention(),
      toSidebarSession: navigation.toSidebarSession,
    });
  };
  return { attention, gateway, host, rows, approvals, update, project };
}

describe("session attention preparation", () => {
  it("builds and formats pending facts once for all rows in an update", () => {
    const { attention, rows, update } = fixture(200);
    const builds = vi.spyOn(questions, "listQuestionPrompts");
    const formats = vi.spyOn(approvalPresentation, "compactApprovalCommand");
    update();
    for (const row of rows) {
      attention.resolveSessionAttention(row);
    }
    attention.knownSessionAttention();
    console.log("ATTENTION_COUNTS", {
      builds: builds.mock.calls.length,
      formats: formats.mock.calls.length,
    });
    expect(builds).toHaveBeenCalledTimes(1);
    expect(formats).toHaveBeenCalledTimes(3);
  });

  it("preserves main aliases, opaque identity casing and agent boundaries", () => {
    const { attention, approvals, update } = fixture(20, 3);
    approvals[0]!.request.sessionKey = "main";
    approvals[1]!.request.sessionKey = "agent:main:matrix:channel:!Room:example.org";
    update();
    const resolve = (key: string) =>
      attention.resolveSessionAttention({ key, kind: "direct", updatedAt: 1 }).kind;
    expect(resolve(" AGENT:MAIN:MAIN ")).toBe("approval");
    expect(resolve("agent:other:main")).toBe("none");
    expect(resolve("agent:main:matrix:channel:!Room:example.org")).toBe("approval");
    expect(resolve("agent:main:matrix:channel:!room:example.org")).toBe("none");
  });

  it("invalidates question replacement and resolution between host updates", () => {
    const { attention, gateway, rows } = fixture();
    expect(attention.knownSessionAttention()).toHaveLength(6);
    gateway.publishEvent("question.requested", {
      id: "question-0",
      status: "pending",
      sessionKey: rows[0]!.key,
      createdAtMs: 10,
      expiresAtMs: Date.now() + 60_000,
      questions: [
        {
          questionId: "continue_run",
          header: "Continue",
          question: "Updated question?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
    expect(
      attention.knownSessionAttention().find((entry) => entry.attention.kind === "question")
        ?.attention.requests[0]?.preview,
    ).toBe("Updated question?");
    gateway.publishEvent("question.resolved", {
      id: "question-0",
      status: "answered",
      answers: { answers: { continue_run: ["Yes"] } },
    });
    expect(attention.knownSessionAttention()).toHaveLength(5);
    expect(attention.resolveSessionAttention(rows[0]!)).toMatchObject({
      kind: "approval",
      requests: [{ id: "approval-0" }],
    });
  });

  it("retires replaced approval queues immediately, including empty and absent sources", () => {
    const { attention, host, rows } = fixture(20, 0);
    const replace = (queue: readonly ExecApprovalRequest[]) => {
      const context = host.sessionAttentionContext;
      host.sessionAttentionContext = {
        ...context,
        overlays: {
          ...context.overlays,
          snapshot: { ...context.overlays.snapshot, approvalQueue: queue },
        },
      };
    };
    expect(attention.resolveSessionAttention(rows[0]!).kind).toBe("none");
    const approval: ExecApprovalRequest = {
      id: "new",
      kind: "exec",
      createdAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
      request: { command: "before", sessionKey: rows[0]!.key },
    };
    replace([approval]);
    expect(attention.resolveSessionAttention(rows[0]!)).toMatchObject({
      requests: [{ preview: "before" }],
    });
    replace([{ ...approval, request: { ...approval.request, command: "after" } }]);
    expect(attention.resolveSessionAttention(rows[0]!)).toMatchObject({
      requests: [{ preview: "after" }],
    });
    replace([]);
    expect(attention.resolveSessionAttention(rows[0]!).kind).toBe("none");
  });

  it("clears prior-client questions when the connection source is replaced", () => {
    const { attention, gateway } = fixture();
    expect(attention.knownSessionAttention()).toHaveLength(6);
    gateway.publish({
      client: { request: async () => ({ questions: [] }) } as unknown as GatewayBrowserClient,
    });
    expect(
      attention.knownSessionAttention().filter((entry) => entry.attention.kind === "question"),
    ).toEqual([]);
  });

  it("keeps unloaded descendant attention and archived suppression in the real projection", () => {
    const { gateway, rows, project } = fixture(20, 0);
    const child = "agent:main:subagent:pending";
    rows[0]!.childSessions = [child];
    gateway.publishEvent("question.requested", {
      id: "child-question",
      status: "pending",
      sessionKey: child,
      createdAtMs: 10,
      expiresAtMs: Date.now() + 60_000,
      questions: [
        {
          questionId: "continue_run",
          header: "Continue",
          question: "Continue child?",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    });
    expect(project()[0]?.attention).toMatchObject({
      kind: "question",
      requests: [{ id: "child-question" }],
    });
    rows[0]!.archived = true;
    expect(project()[0]?.attention.kind).toBe("none");
    rows[0]!.archived = false;
    gateway.publishEvent("question.resolved", { id: "child-question", status: "cancelled" });
    expect(project()[0]?.attention.kind).toBe("none");
  });

  it("does not retain approvals after the owning overlay revokes review permission", () => {
    const { attention, gateway, host, rows, update } = fixture(20, 0);
    const overlays = createApplicationOverlays(gateway.gateway);
    disposals.push(() => overlays.dispose());
    host.sessionAttentionContext = { ...host.sessionAttentionContext, overlays };
    update();
    const payload = {
      id: "restricted",
      createdAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
      request: { command: "private command", sessionKey: rows[0]!.key },
    };
    gateway.publishEvent("exec.approval.requested", payload);
    expect(attention.resolveSessionAttention(rows[0]!).kind).toBe("approval");
    gateway.publish({ hello: gatewayHelloForMethods([], ["operator.read"]) });
    expect(attention.resolveSessionAttention(rows[0]!).kind).toBe("none");
    gateway.publishEvent("exec.approval.requested", payload);
    expect(attention.knownSessionAttention()).toEqual([]);
  });

  it("invalidates expired questions using the existing question-owner clock", () => {
    vi.useFakeTimers();
    try {
      const { attention } = fixture(20, 1);
      expect(
        attention.knownSessionAttention().filter((entry) => entry.attention.kind === "question"),
      ).toHaveLength(1);
      vi.advanceTimersByTime(60_001);
      expect(
        attention.knownSessionAttention().filter((entry) => entry.attention.kind === "question"),
      ).toEqual([]);
    } finally {
      disposals.splice(0).forEach((dispose) => dispose());
      vi.useRealTimers();
    }
  });

  it("measures the same modest per-update row lookup workload", () => {
    if (!process.env.ATTENTION_BENCHMARK) {
      return;
    }
    const report = [];
    for (const count of [20, 100, 200]) {
      for (const pending of [0, 3]) {
        const { project, update } = fixture(count, pending);
        const samples: number[] = [];
        for (let run = 0; run < 120; run++) {
          update();
          const start = performance.now();
          project();
          const elapsed = performance.now() - start;
          if (run >= 20) {
            samples.push(elapsed);
          }
        }
        samples.sort((a, b) => a - b);
        report.push({ count, pending, medianMs: samples[50], p95Ms: samples[95] });
      }
    }
    console.log("ATTENTION_BENCHMARK", JSON.stringify(report));
  });
});
