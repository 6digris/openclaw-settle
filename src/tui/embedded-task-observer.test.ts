import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { callInProcessGatewayTool } from "../agents/tools/in-process-gateway.js";
import { createProgressCardTool } from "../agents/tools/progress-card-tool.js";
import { createDefaultDeps } from "../cli/deps.js";
import { getRuntimeConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  configureInMemoryTaskStoresForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-registry.test-support.js";
import { resetTaskFlowRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { EmbeddedTaskObserver } from "./embedded-task-observer.js";
import { createTuiTaskProgressController } from "./tui-task-progress.js";

it("renders committed local authored steps, refuses stale clears, and clears through the same session owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetTaskRegistryForTests({ persist: false });
    resetTaskFlowRegistryForTests({ persist: false });
    configureInMemoryTaskStoresForTests();
    const sessionKey = "agent:main:local-checklist";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "checklist-session", updatedAt: 1 },
    );
    const observer = new EmbeddedTaskObserver(({ event, payload }) =>
      view.handleEvent(event, payload),
    );
    const view = createTuiTaskProgressController({
      client: observer,
      getScope: () => ({ sessionKey, agentId: "main" }),
      requestRender: () => {},
    });
    const render = () => stripAnsi(view.component.render(100).join("\n"));
    const tool = createProgressCardTool({ agentSessionKey: sessionKey, agentId: "main" });
    observer.start();
    try {
      await withLocalGatewayRequestScope(
        { deps: createDefaultDeps(), getRuntimeConfig },
        async () => {
          await view.connect();
          await tool.execute("plan-start", {
            plan: [{ step: "Inspect child result", status: "pending" }],
          });
          await vi.waitFor(() => expect(render()).toContain("[ ] Inspect child result"));
          const first = expectDefined(
            (await observer.getProgressCard({ sessionKey, agentId: "main" })).card,
            "committed checklist",
          );
          await tool.execute("plan-finish", {
            plan: [{ step: "Inspect child result", status: "completed" }],
          });
          await vi.waitFor(() => expect(render()).toContain("[x] Inspect child result"));
          await callInProcessGatewayTool("progressCard.put", {
            sessionKey,
            agentId: "main",
            expectedRevision: first.revision,
          });
          expect(
            (await observer.getProgressCard({ sessionKey, agentId: "main" })).card?.steps?.[0]
              ?.status,
          ).toBe("completed");
          await expect(
            callInProcessGatewayTool(
              "progressCard.put",
              { sessionKey, agentId: "main", markdown: "Must not be stored" },
              {
                sessionMutationCommitGuard: () => {
                  throw new Error("Retired turn");
                },
              },
            ),
          ).rejects.toThrow("Retired turn");
          expect(
            (await observer.getProgressCard({ sessionKey, agentId: "main" })).card?.markdown,
          ).toBeUndefined();
          await tool.execute("plan-clear", {});
          await vi.waitFor(() => expect(render()).not.toContain("Session checklist"));
          expect((await observer.getProgressCard({ sessionKey, agentId: "main" })).card).toBeNull();
        },
      );
    } finally {
      view.dispose();
      await observer.stop();
      await view.settled();
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    }
  });
});
