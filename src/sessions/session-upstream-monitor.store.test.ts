import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acceptSessionEventStoreTestConfig,
  captureSessionEventStoreTestConfig,
} from "../../test/helpers/infra/session-event-store.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import type {
  SessionCatalogProvider,
  SessionUpstreamActivity,
} from "../plugins/session-catalog.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listSessionStateEventsSince } from "./session-state-events.js";
import { readCursor } from "./session-state-events.kernel.js";
import { registerSessionStateWatch } from "./session-state-watches.js";
import { readSessionUpstreamLink, upsertSessionUpstreamLink } from "./session-upstream-links.js";
import { runSessionUpstreamMonitorTick } from "./session-upstream-monitor.test-support.js";

describe("upstream scan notification ownership", () => {
  it.each(
    (["activity", "missing"] as const).flatMap((kind) =>
      [false, true].map((replaced) => ({ kind, replaced })),
    ),
  )(
    "keeps $kind attached to its original watcher store (replaced: $replaced)",
    async ({ kind, replaced }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
        const restoreStore = captureSessionEventStoreTestConfig();
        const watcher = "agent:main:main";
        const target = "agent:other:adopted:watched";
        const agentsRoot = path.join(stateDir, "session-stores");
        const original = path.join(stateDir, "watcher-original");
        const replacement = path.join(stateDir, "watcher-replacement");
        const selected = path.join(agentsRoot, "main");
        const replacementAlias = path.join(agentsRoot, "next-main");
        const targetStore = path.join(agentsRoot, "other", "sessions.json");
        const cfg: OpenClawConfig = {
          agents: { entries: { main: {}, other: {} } },
          session: { store: path.join(agentsRoot, "{agentId}", "sessions.json") },
        };
        const scanStarted = createDeferred();
        const scanResult = createDeferred<SessionUpstreamActivity[]>();
        const outcomes: SessionUpstreamActivity[] =
          kind === "missing"
            ? [{ kind, sessionKey: target }]
            : [
                {
                  kind,
                  sessionKey: target,
                  humanTurns: 1,
                  occurredAt: Date.now(),
                  dedupeId: "scan-1",
                  nextMarker: { offset: 8 },
                },
              ];
        let scans = 0;
        const checkUpstreamActivity = vi.fn(async () => {
          scans++;
          if (kind === "missing" && scans < 3) {
            return outcomes;
          }
          scanStarted.resolve();
          return scanResult.promise;
        });
        const provider: SessionCatalogProvider = {
          id: "proof",
          label: "Proof",
          list: async () => [],
          read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
          checkUpstreamActivity,
        };
        const missingCounts = new Map<string, { count: number; linkUpdatedAt: number }>();
        const options = {
          providers: [provider],
          loadEntry: (scope: Parameters<typeof loadSessionEntryReadOnly>[0]) =>
            loadSessionEntryReadOnly({ ...scope, storePath: targetStore }),
          isRunActive: () => false,
          loadOwnRecentUserTexts: async () => [],
        };
        let tick: Promise<void> | undefined;
        try {
          await fs.mkdir(agentsRoot);
          await fs.mkdir(original);
          await fs.mkdir(replacement);
          await fs.symlink(original, selected, "junction");
          await fs.symlink(replacement, replacementAlias, "junction");
          acceptSessionEventStoreTestConfig(cfg);
          await upsertSessionEntryCore(
            {
              agentId: "other",
              sessionKey: target,
              storePath: targetStore,
            },
            { sessionId: "unchanged-target", updatedAt: 1 },
          );
          expect(options.loadEntry({ agentId: "other", sessionKey: target })).toMatchObject({
            sessionId: "unchanged-target",
          });
          expect(
            upsertSessionUpstreamLink({
              sessionKey: target,
              agentId: "other",
              catalogId: "proof",
              hostId: "gateway:local",
              threadId: "unchanged-thread",
              upstreamKind: "claude-cli",
              upstreamRef: { source: "unchanged-source" },
              marker: { offset: 0 },
            }),
          ).toBe(true);
          const register = () =>
            registerSessionStateWatch({ watcherSessionKey: watcher, targetSessionKey: target });
          expect(register()).toBe(true);
          if (kind === "missing") {
            await runSessionUpstreamMonitorTick(options, missingCounts);
            await runSessionUpstreamMonitorTick(options, missingCounts);
            expect(checkUpstreamActivity).toHaveBeenCalledTimes(2);
          }
          tick = runSessionUpstreamMonitorTick(options, missingCounts);
          await Promise.race([
            scanStarted.promise,
            tick.then(() => {
              throw new Error("Upstream tick completed without reaching the provider scan");
            }),
          ]);
          if (replaced) {
            await fs.rename(replacementAlias, selected);
          }
          acceptSessionEventStoreTestConfig(cfg);
          expect(register()).toBe(true);
          const db = openOpenClawStateDatabase().db;
          const beforeResume = readCursor(db, watcher, target);
          scanResult.resolve(outcomes);
          await tick;

          const events = listSessionStateEventsSince(target, "other", 0, 20).events;
          expect(events).toHaveLength(1);
          expect(events[0]?.kind).toBe(
            kind === "missing" ? "upstream_missing" : "human_direct_message",
          );
          if (replaced) {
            expect(readCursor(db, watcher, target)).toEqual(beforeResume);
            expect(peekSystemEventEntries(watcher)).toEqual([]);
          } else {
            expect(readCursor(db, watcher, target)).toMatchObject({
              notified_sequence: events[0]?.sequence,
              material_sequence: events[0]?.sequence,
            });
            expect(peekSystemEventEntries(watcher)).toHaveLength(1);
          }
          if (kind === "missing") {
            expect(readSessionUpstreamLink(target, "other")).toBeUndefined();
          } else {
            expect(readSessionUpstreamLink(target, "other")?.marker).toEqual({ offset: 8 });
          }
        } finally {
          scanResult.resolve(outcomes);
          try {
            await tick;
          } finally {
            restoreStore();
          }
        }
      });
    },
  );
});
