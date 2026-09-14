import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { MemoryManagerSessionSyncOps } from "./manager-session-sync-ops.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

const transcriptSubscription = vi.hoisted(() => ({
  listener: undefined as
    | Parameters<
        typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation").onInternalSessionTranscriptUpdate
      >[0]
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    onInternalSessionTranscriptUpdate: (
      listener: Parameters<typeof actual.onInternalSessionTranscriptUpdate>[0],
    ) => {
      transcriptSubscription.listener = listener;
      const unsubscribe = actual.onInternalSessionTranscriptUpdate(listener);
      return () => {
        unsubscribe();
        if (transcriptSubscription.listener === listener) {
          transcriptSubscription.listener = undefined;
        }
      };
    },
  };
});

describe("memory session ingress close", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([
    ["startup catch-up", "runSessionStartupCatchup"],
    ["file transcript update", "scheduleCorpusSessionFileDirty"],
    ["debounced identity update", "processSessionUpdateBatch"],
    ["rejected file transcript update", "scheduleCorpusSessionFileDirty"],
  ] as const)(
    "drains session ingress before close: %s",
    async (ingress, selectedMethod) => {
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      await fs.mkdir(sessionsDir, { recursive: true });
      const cfg: OpenClawConfig = isolateMemoryManagerTestConfig({
        memory: {
          search: {
            provider: "openai",
            model: "mock-embed",
            store: { vector: { enabled: false } },
            query: { minScore: 0 },
          },
        },
        agents: { entries: { main: { workspace: fixture.paths.workspace } } },
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const order: string[] = [];
      const accepted: Promise<unknown>[] = [];
      const observations: Promise<void>[] = [];
      async function drainAccepted() {
        let drained = 0;
        while (drained < accepted.length) {
          const end = accepted.length;
          await Promise.allSettled([
            ...accepted.slice(drained, end),
            ...observations.slice(drained, end),
          ]);
          drained = end;
        }
      }
      const methods = [
        "runSessionStartupCatchup",
        "scheduleCorpusSessionFileDirty",
        "processSessionUpdateBatch",
      ] as const;
      const owner = MemoryManagerSessionSyncOps.prototype as unknown as Record<
        (typeof methods)[number],
        (...args: never[]) => Promise<unknown>
      >;
      // Observe the original ingress promises for ordering and teardown, never invoke them.
      const ingressSpies = methods.map((method) => {
        const original = owner[method];
        return vi.spyOn(owner, method).mockImplementation(function (
          this: MemoryManagerSessionSyncOps,
          ...args
        ) {
          const pending = original.apply(this, args);
          accepted.push(pending);
          observations.push(
            pending.then(
              () => {
                if (method === selectedMethod) {
                  order.push("ingress settled");
                }
              },
              () => {
                if (method === selectedMethod) {
                  order.push("ingress rejected");
                }
              },
            ),
          );
          return pending;
        });
      });
      const realpath = fs.realpath.bind(fs);
      let pauseDiscovery = ingress === "startup catch-up";
      let rejectDiscovery = false;
      const readdir = fs.readdir.bind(fs);
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((...args) => {
        if (rejectDiscovery && args[0] === sessionsDir) {
          rejectDiscovery = false;
          return Promise.reject(
            Object.assign(new Error("session corpus read failed"), { code: "EIO" }),
          );
        }
        return readdir(...args);
      });
      const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (file) => {
        if (pauseDiscovery && file === sessionsDir) {
          pauseDiscovery = false;
          entered.resolve();
          await release.promise;
        }
        return realpath(file);
      });
      let activeManager: MemoryIndexManager | undefined;
      let closing: Promise<void> | undefined;
      try {
        activeManager = await fixture.getFreshManager(cfg);
        expect(activeManager.status().sources).toEqual(
          expect.arrayContaining(["memory", "sessions"]),
        );
        if (ingress !== "startup catch-up") {
          await Promise.all(accepted);
          pauseDiscovery = true;
          expect(transcriptSubscription.listener).toBeTypeOf("function");
          if (selectedMethod === "scheduleCorpusSessionFileDirty") {
            transcriptSubscription.listener!({
              sessionFile: path.join(sessionsDir, "close-drain.jsonl"),
            });
          } else {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            transcriptSubscription.listener!({
              target: {
                agentId: "main",
                sessionId: "close-drain",
                sessionKey: "agent:main:chat:close-drain",
              },
            });
            await vi.advanceTimersByTimeAsync(5_000);
          }
        }
        await expect(
          Promise.race([
            entered.promise.then(() => "discovery held"),
            Promise.all(accepted).then(() => "ingress completed"),
          ]),
        ).resolves.toBe("discovery held");
        vi.useRealTimers();
        const retainedListener = transcriptSubscription.listener!;
        closing = activeManager.close().then(() => {
          order.push("close settled");
        });
        retainedListener({ sessionFile: path.join(sessionsDir, "late-close-drain.jsonl") });
        // Give close its normal event-loop turn while corpus discovery remains withheld.
        await setImmediate();
        rejectDiscovery = ingress === "rejected file transcript update";
        release.resolve();
        await drainAccepted();
        await closing;
        expect(order).toEqual([
          ingress === "rejected file transcript update" ? "ingress rejected" : "ingress settled",
          "close settled",
        ]);
      } finally {
        release.resolve();
        try {
          await drainAccepted();
          await Promise.allSettled([closing, activeManager?.close()]);
          await drainAccepted();
        } finally {
          realpathSpy.mockRestore();
          readdirSpy.mockRestore();
          for (const spy of ingressSpies) {
            spy.mockRestore();
          }
          vi.useRealTimers();
        }
      }
    },
    120_000,
  );
});
