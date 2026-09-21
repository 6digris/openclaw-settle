import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
} from "../infra/plugin-approvals.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import {
  createApprovalRequestPolicy,
  createContext,
  createOperatorClient,
  expectApprovalResolution,
  expectSinglePendingApproval,
  invokeDemoPolicy,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";

const hasApprovalTurnSourceRouteMock = vi.hoisted(() =>
  vi.fn(
    (params: { turnSourceChannel?: string | null; approvalKind?: ChannelApprovalKind }) =>
      params.approvalKind === "plugin" && params.turnSourceChannel === "tui",
  ),
);

vi.mock("../infra/approval-turn-source.js", () => ({
  hasApprovalTurnSourceRoute: hasApprovalTurnSourceRouteMock,
}));

describe("node policy iOS approval delivery", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    hasApprovalTurnSourceRouteMock.mockClear();
  });
  afterEach(resetPluginRuntimeStateForTest);

  it("delivers plugin policy approvals to visible iOS reviewers", async (testContext) => {
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const handleRequested = vi.fn(
      async (
        _request: PluginApprovalRequest,
        _opts?: {
          isTargetVisible?: (target: { deviceId: string; scopes: readonly string[] }) => boolean;
        },
      ) => true,
    );
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: vi.fn(() => new Set<string>()),
      hasExecApprovalClients: vi.fn(() => false),
      pluginApprovalIosPushDelivery: { handleRequested },
    });

    await expectSinglePendingApproval(
      manager,
      context,
      () => invokeDemoPolicy(context, createOperatorClient()),
      async (record, resultPromise) => {
        expect(handleRequested).toHaveBeenCalledTimes(1);
        const deliveryOptions = handleRequested.mock.calls[0]?.[1];
        expect(
          deliveryOptions?.isTargetVisible?.({
            deviceId: "device-owner",
            scopes: ["operator.approvals", "operator.read"],
          }),
        ).toBe(true);
        expect(
          deliveryOptions?.isTargetVisible?.({
            deviceId: "device-other",
            scopes: ["operator.approvals", "operator.read"],
          }),
        ).toBe(false);

        await expectApprovalResolution(resultPromise, manager, record);
      },
    );
  });

  it("sends an iOS cleanup wake through the current delivery owner", async (testContext) => {
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const handleExpired = vi.fn(async () => {});
    setDangerousDemoCommandRegistry([createApprovalRequestPolicy()]);
    const { context } = createContext({
      pluginApprovalManager: manager,
      getApprovalClientConnIds: vi.fn(() => new Set<string>()),
      hasExecApprovalClients: vi.fn(() => false),
      pluginApprovalIosPushDelivery: {
        handleRequested: vi.fn(async () => true),
        handleExpired,
      },
    });

    await expectSinglePendingApproval(
      manager,
      context,
      () => invokeDemoPolicy(context, createOperatorClient()),
      async (record, resultPromise) => {
        const replacementExpired = vi.fn(async () => {});
        context.pluginApprovalIosPushDelivery = { handleExpired: replacementExpired };
        await manager.expire(record.id, "timeout");

        await expect(resultPromise).resolves.toStrictEqual({
          ok: true,
          payload: { id: record.id, decision: null },
        });
        expect(handleExpired).not.toHaveBeenCalled();
        expect(replacementExpired).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
        expect(replacementExpired.mock.contexts).toEqual([context.pluginApprovalIosPushDelivery]);
      },
    );
  });
});
