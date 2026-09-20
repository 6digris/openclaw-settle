import { afterEach, expect, it, vi } from "vitest";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "../device-revocation.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import * as operatorApprovalStore from "../operator-approval-store.async.js";
import { listTerminalOperatorApprovals } from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import {
  createApprovalInvocation,
  createClient,
  getOperatorApproval,
} from "./approval.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { method: "approval.get", opaqueGuard: false, requestState: "current" },
  { method: "approval.resolve", opaqueGuard: false, requestState: "current" },
  { method: "approval.get", opaqueGuard: true, requestState: "current" },
  { method: "approval.resolve", opaqueGuard: true, requestState: "current" },
  { method: "approval.resolve", opaqueGuard: false, requestState: "revoked-before-entry" },
  { method: "approval.resolve", opaqueGuard: false, requestState: "transport-retired" },
] as const)(
  "honors $requestState custody for $method (opaqueGuard=$opaqueGuard)",
  async ({ method, opaqueGuard, requestState }) => {
    await withOpenClawTestState({ label: "approval-request-custody" }, async (state) => {
      const databaseOptions = { env: state.env };
      openOpenClawStateDatabase(databaseOptions);
      const persistence = { runtimeEpoch: "request-custody-test", databaseOptions };
      const exec = new ExecApprovalManager<ExecApprovalRequestPayload>({
        persistence,
        resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      });
      const plugin = new ExecApprovalManager<PluginApprovalRequestPayload>({
        approvalKind: "plugin",
        persistence,
      });
      const record = exec.create({ command: "echo fixture" }, 600_000, "request-custody");
      record.approvalReviewerDeviceIds = ["reviewer"];
      const decision = exec.register(record, 600_000);
      let settled = false;
      void decision.then(() => {
        settled = true;
      });
      const handlers = createApprovalHandlers({
        execApprovalManager: exec,
        pluginApprovalManager: plugin,
        databaseOptions,
      });
      const lookup = vi.spyOn(operatorApprovalStore, "getOperatorApprovalDetailedAsync");
      const commitGuard = vi.fn(() => {
        // This ordinary storage read must stay outside a worker admission callback.
        listTerminalOperatorApprovals({ databaseOptions });
      });
      if (opaqueGuard) {
        lookup.mockImplementation(() => {
          throw new Error("opaque guard must retain its native SQLite boundary");
        });
      }
      try {
        const client = createClient({ deviceId: "reviewer" });
        const connection = new AbortController();
        if (requestState === "transport-retired") {
          client.connectionSignal = connection.signal;
        }
        const invocation = createApprovalInvocation({
          handlers,
          method,
          body: {
            id: record.id,
            ...(method === "approval.resolve" ? { kind: "exec", decision: "allow-once" } : {}),
          },
          client,
          ...(opaqueGuard ? { sessionMutationCommitGuard: commitGuard } : {}),
        });
        const before =
          requestState === "revoked-before-entry"
            ? getOperatorApproval({ id: record.id, databaseOptions })
            : undefined;
        if (requestState === "revoked-before-entry") {
          expect(before).toMatchObject({
            status: "pending",
            decision: null,
            resolvedAtMs: null,
            terminalReason: null,
            resolver: null,
          });
          invalidateGatewayDeviceRevocation(invocation.context, "reviewer", "operator");
        } else if (requestState === "transport-retired") {
          connection.abort();
          expect(client.connectionSignal?.aborted).toBe(true);
        }
        const response = await invocation.invoke();
        if (requestState === "revoked-before-entry") {
          expect(response).toMatchObject({
            ok: false,
            error: { message: "approval not found" },
          });
          expect(getOperatorApproval({ id: record.id, databaseOptions })).toEqual(before);
          expect(exec.getLiveSnapshot(record.id)).toBe(record);
          expect(record.resolvedAtMs).toBeUndefined();
          expect(settled).toBe(false);
          expect(invocation.context.approvalEvents?.publishResolved).not.toHaveBeenCalled();
          expect(invocation.context.broadcast).not.toHaveBeenCalled();
          expect(invocation.context.broadcastToConnIds).not.toHaveBeenCalled();
          return;
        }
        const expectedStatus = method === "approval.resolve" ? "allowed" : "pending";
        expect(response).toMatchObject({
          ok: true,
          result: { approval: { id: record.id, status: expectedStatus } },
        });
        expect(getOperatorApproval({ id: record.id, databaseOptions })).toMatchObject({
          status: expectedStatus,
        });
        if (method === "approval.resolve") {
          await expect(decision).resolves.toBe("allow-once");
        } else {
          expect(exec.getLiveSnapshot(record.id)).toBe(record);
        }
        if (opaqueGuard) {
          expect(commitGuard).toHaveBeenCalled();
          expect(lookup).not.toHaveBeenCalled();
        } else {
          expect(lookup).toHaveBeenCalledOnce();
        }
      } finally {
        await Promise.all([exec.drain(), plugin.drain()]);
      }
    });
  },
);
