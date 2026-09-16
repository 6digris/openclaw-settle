/** Registers duplicate-completion regressions inside the owning lifecycle fixture. */
import { expect, it, vi, type Mock } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { readSubagentRunAnnounceResultUsing } from "../announce/subagent-announce-result.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "./subagent-lifecycle-events.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleControllerParams = SubagentLifecycleOptions;
type CompletionFixtures = {
  createRunEntry: (overrides?: Partial<SubagentRunRecord>) => SubagentRunRecord;
  createLifecycleController: (
    params: { entry: SubagentRunRecord } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  makeSubagentCompletion: (
    entry: SubagentRunRecord,
    overrides?: Omit<Partial<SubagentCompletionRequest>, "runId">,
  ) => SubagentCompletionRequest;
  waitForLifecycleState: <T>(assertion: () => T | Promise<T>) => Promise<T>;
  browserLifecycleCleanupMocks: {
    cleanupBrowserSessionsForLifecycleEnd: Mock<() => Promise<void>>;
  };
  bundleMcpRuntimeMocks: {
    retireSessionMcpRuntimeForSessionKey: Mock<() => Promise<boolean>>;
  };
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
};

export function registerCompletionCallbackReplayTests({
  createRunEntry,
  createLifecycleController,
  makeSubagentCompletion,
  waitForLifecycleState,
  browserLifecycleCleanupMocks,
  bundleMcpRuntimeMocks,
  helperMocks,
}: CompletionFixtures): void {
  it("drains the retire + announce tail for a duplicate completion held behind a slow first browser cleanup", async () => {
    // The dispatch flag dedupes only the browser tab-close IPC. A duplicate
    // completion caller must still reach retireRunModeBundleMcpRuntime and
    // startSubagentAnnounceCleanupFlow while the first caller's cleanup
    // promise is still pending, so a slow browser driver cannot strand
    // completion delivery behind it.
    const entry = createRunEntry({
      expectsCompletionMessage: true,
    });
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });

    let releaseFirstCleanup: (() => void) | undefined;
    let firstCleanupEntered: (() => void) | undefined;
    const firstCleanupEnteredPromise = new Promise<void>((resolve) => {
      firstCleanupEntered = resolve;
    });
    browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd.mockImplementationOnce(
      () => {
        firstCleanupEntered?.();
        return new Promise<void>((resolve) => {
          releaseFirstCleanup = resolve;
        });
      },
    );

    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "ok" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
      terminalReply: { disposition: "visible" as const, text: "final completion reply" },
    };

    // First caller takes the dispatch flag and parks inside the cleanup wrapper.
    const firstCompletion = controller.completeSubagentRun(completeParams);
    await firstCleanupEnteredPromise;

    // Second caller observes the flag set, skips the cleanup wrapper, and must
    // still drain the retire + announce tail without waiting on the first
    // caller's still-pending cleanup.
    await controller.completeSubagentRun({ ...completeParams, endedAt: 3_999 });

    expect(
      browserLifecycleCleanupMocks.cleanupBrowserSessionsForLifecycleEnd,
    ).toHaveBeenCalledTimes(1);
    expect(entry.execution.endedAt).toBe(4_000);
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntimeForSessionKey).toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalled();

    // Release the held first cleanup so the first caller can settle too.
    releaseFirstCleanup?.();
    await expect(firstCompletion).resolves.toBeUndefined();
  });

  it.each(["reading", "delivering"] as const)(
    "keeps the completion handoff valid when an equivalent callback arrives while %s",
    async (phase) => {
      const entry = createRunEntry({
        expectsCompletionMessage: true,
        execution: {
          status: "running",
          transcriptTarget: {
            agentId: "main",
            sessionId: "child-session",
            sessionKey: "agent:main:subagent:child",
            storePath: "/tmp/subagent-completion-store",
          },
        },
      });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const deliveredResults: string[] = [];
      const runSubagentAnnounceFlow = vi.fn<LifecycleControllerParams["runSubagentAnnounceFlow"]>(
        async () => {
          const prepared = await readSubagentRunAnnounceResultUsing(entry, {
            getRuntimeConfig: () => ({}),
            readSubagentSessionEntry: () => undefined,
            resolveAgentIdFromSessionKey: () => "main",
            resolveSessionStorePathCore: () => "/tmp/subagent-completion-store",
            findSessionTranscriptArchiveEventReadOnly: async () => undefined,
            findTranscriptEvent: async () => {
              if (phase === "reading") {
                entered.resolve();
                await release.promise;
              }
              return {
                event: {
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "complete child answer" }],
                    __openclaw: { runId: entry.runId },
                  },
                },
              };
            },
          });
          if (phase === "delivering") {
            entered.resolve();
            await release.promise;
          }
          if (!prepared.isCurrent()) {
            return "intentional_non_delivery";
          }
          deliveredResults.push(prepared.text ?? "");
          return "delivered";
        },
      );
      const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
      const completion = makeSubagentCompletion(entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "complete child answer" },
      });
      try {
        await controller.completeSubagentRun(completion);
        await entered.promise;
        await controller.completeSubagentRun(structuredClone(completion));
        release.resolve();

        await waitForLifecycleState(() => expect(entry.delivery?.status).toBe("delivered"));
        expect(deliveredResults).toEqual(["complete child answer"]);
        expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        controller.clearScheduledResumeTimers();
      }
    },
  );

  it("does not invalidate an active timeout tail when a published timeout is observed again", async () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      runTimeoutSeconds: 2,
    });
    let releaseTiming: (() => void) | undefined;
    helperMocks.persistSubagentSessionTiming.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTiming = resolve;
        }),
    );
    const runSubagentAnnounceFlow = vi.fn<
      (_params: unknown) => ReturnType<LifecycleControllerParams["runSubagentAnnounceFlow"]>
    >(async () => "delivered");
    const controller = createLifecycleController({ entry, runSubagentAnnounceFlow });
    const completeParams = {
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "timeout" as const },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      triggerCleanup: true,
    };

    const firstCompletion = controller.completeSubagentRun(completeParams);
    await waitForLifecycleState(() =>
      expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce(),
    );
    entry.endedHookEmittedAt = 4_000;

    await controller.completeSubagentRun(completeParams);
    releaseTiming?.();
    await firstCompletion;

    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    expect(runSubagentAnnounceFlow.mock.calls[0]?.[0]).toMatchObject({
      outcome: { status: "timeout" },
    });
  });
}
