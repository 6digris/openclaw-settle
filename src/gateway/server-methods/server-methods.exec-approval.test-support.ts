import { vi, type TestContext } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createChatRunState } from "../server-chat-state.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

export function createExecApprovalFixture(
  testContext: TestContext,
  opts?: { config?: OpenClawConfig },
  manager = createTestApprovalManager(testContext),
) {
  const handlers = createExecApprovalHandlers(manager);
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const respond = vi.fn();
  const context = {
    getRuntimeConfig: () => opts?.config ?? {},
    broadcast: (event: string, payload: unknown) => {
      broadcasts.push({ event, payload });
    },
    hasExecApprovalClients: () => true,
    chatRunState: createChatRunState(),
  };
  return { manager, handlers, broadcasts, respond, context };
}
