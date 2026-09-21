import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type { ActivitySummaryTarget } from "./session-activity-summary-state.js";
import type { SessionRowProjection } from "./session-row-projection.js";

type Start = (projection: SessionRowProjection) => {
  params: { broadcast: GatewayBroadcastFn };
  unsubs: { agentUnsub: () => Promise<void> };
};

export function registerActivitySummaryPublicationTests(
  start: Start,
  getOnChanged: () => ((target: ActivitySummaryTarget) => void) | undefined,
): void {
  it.each([false, true])(
    "publishes a ready activity-summary target during unrelated refresh (same-ID reset: %s)",
    async (reset) => {
      vi.useFakeTimers();
      const readStarted = createDeferred();
      const prepared = createDeferred();
      const unrelatedRefresh = createDeferred();
      let unrelatedDirty = true;
      const target = {
        key: "agent:main:activity",
        agentId: "main",
        storePath: "/tmp/activity-summary-tracked.sqlite",
      };
      const original = { sessionId: "same-session", lifecycleRevision: "original" };
      let current = original;
      const projection = {
        capture: () => current,
        ensureMaterialized: () => {
          readStarted.resolve();
          return unrelatedRefresh.promise;
        },
        get needsMaterialization() {
          return unrelatedDirty;
        },
        withPreparedExactRows: async (
          queries: Parameters<SessionRowProjection["withPreparedExactRows"]>[0],
          consume: () => void,
        ) => {
          readStarted.resolve();
          expect(queries({})).toEqual([{ key: target.key, agentId: target.agentId }]);
          await prepared.promise;
          return { kind: "complete", value: consume() };
        },
        isCurrent: (record: typeof original) => record === current,
        snapshot: () => ({ row: { key: target.key, ...current } }),
      } as unknown as SessionRowProjection;
      const { params, unsubs } = start(projection);
      const onChanged = getOnChanged();
      if (!onChanged) {
        throw new Error("missing activity-summary publication callback");
      }
      try {
        onChanged(target);
        await readStarted.promise;
        expect(params.broadcast).not.toHaveBeenCalled();
        if (reset) {
          current = { ...original, lifecycleRevision: "replacement" };
        }
        prepared.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (reset) {
          expect(params.broadcast).not.toHaveBeenCalled();
        } else {
          expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            expect.objectContaining({
              reason: "activity-summary",
              session: expect.objectContaining({ key: target.key, ...original }),
            }),
            { sessionKeys: [target.key], agentId: target.agentId, dropIfSlow: true },
          );
        }
      } finally {
        prepared.resolve();
        unrelatedDirty = false;
        unrelatedRefresh.resolve();
        await unsubs.agentUnsub();
      }
      expect(params.broadcast).toHaveBeenCalledTimes(reset ? 0 : 1);
    },
  );
}
