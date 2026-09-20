import { afterEach, expect, it, vi } from "vitest";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import * as operatorApprovalStore from "../operator-approval-store.async.js";
import { listTerminalOperatorApprovals } from "../operator-approval-store.js";
import { createApprovalHandlers } from "./approval.js";
import { createClient, getOperatorApproval, invoke } from "./approval.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { method: "approval.get" as const, opaqueGuard: false },
  { method: "approval.resolve" as const, opaqueGuard: false },
  { method: "approval.get" as const, opaqueGuard: true },
  { method: "approval.resolve" as const, opaqueGuard: true },
])(
  "keeps $method storage compatible with opaqueGuard=$opaqueGuard",
  async ({ method, opaqueGuard }) => {
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
        const response = await invoke({
          handlers,
          method,
          body: {
            id: record.id,
            ...(method === "approval.resolve" ? { kind: "exec", decision: "allow-once" } : {}),
          },
          client: createClient({ deviceId: "reviewer" }),
          ...(opaqueGuard ? { sessionMutationCommitGuard: commitGuard } : {}),
        });
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
