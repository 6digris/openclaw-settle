import { StatementSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getDeterministicFreePortBlock, getFreePort } from "../test-utils/ports.js";
import { CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import * as coreRuntime from "./server-core-runtime.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import { createGatewayKernel } from "./server-kernel.js";
import * as lifecycleRuntime from "./server-lifecycle.js";
import * as optionalCatalog from "./server-methods/optional-model-catalog.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { ready } from "./session-row-projection-record.js";
import type { GatewaySessionRow, SessionsListResult } from "./session-utils.types.js";
import {
  placementTurnOwner,
  reportPlacementTransition,
} from "./worker-environments/placement-record.js";
import { seedAttachedPlacementEnvironment } from "./worker-environments/placement-test-fixtures.js";

describe("Gateway startup", () => {
  it("batches placement refreshes through the kernel without warming unselected archives during catalog renewal", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-kernel-placement-projection",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        VITEST: "1",
      },
    });
    const catalogFor = (contextWindow: number) =>
      new Map([
        [
          "main",
          {
            entries: [
              {
                id: "model",
                name: "Fixture",
                provider: "unit-test",
                contextWindow,
              },
            ],
          },
        ],
      ]);
    let currentCatalog = catalogFor(8192);
    const renewing = createDeferredCore<typeof currentCatalog>();
    const renewalStarted = createDeferredCore();
    let holdRenewal = false;
    const catalogRead = vi
      .spyOn(optionalCatalog, "readPreparedServerMethodModelCatalogs")
      .mockImplementation(async () => {
        if (holdRenewal) {
          renewalStarted.resolve();
          return renewing.promise;
        }
        return currentCatalog;
      });
    const releaseBackground = retainSessionListForegroundWork();
    const token = "gateway-kernel-placement-token";
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    const live = Array.from({ length: 256 }, (_, index) => ({
      target: { agentId: "main", sessionKey: `agent:main:live-${index}` },
      entry: {
        sessionId: `live-${index}`,
        updatedAt: 1000 + index,
        label: `before-${index}`,
        providerOverride: "unit-test",
        modelOverride: "model",
      },
    }));
    const archived = Array.from({ length: 128 }, (_, index) => ({
      target: { agentId: "main", sessionKey: `agent:main:archive-${index}` },
      entry: {
        sessionId: `archive-${index}`,
        updatedAt: 2000 + index,
        archivedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "model",
      },
    }));
    try {
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
        agents: { defaults: { model: "unit-test/model", utilityModel: "" } },
      });
      state.applyEnv();
      for (const { target, entry } of [...live, ...archived]) {
        replaceSessionEntrySync(target, entry);
      }
      kernel = await createGatewayKernel(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      kernel.kernel.setDispatchReady(true);
      kernel.kernel.unlockStartupMethods();
      kernel.kernel.markSidecarsReady();
      const placements = kernel.workerEnvironmentStartup?.placementStore;
      const projection = getSessionRowProjection(kernel.gatewayRequestContext);
      if (!placements || !projection) {
        throw new Error("Expected the kernel's placement and projection owners");
      }
      const database = openOpenClawStateDatabase();
      for (const index of [254, 255]) {
        const { target, entry } = live[index]!;
        const identity = { ...target, sessionId: entry.sessionId };
        const environmentId = `environment-${index}`;
        seedAttachedPlacementEnvironment(database, {
          environmentId,
          sessionId: identity.sessionId,
          ownerEpoch: 7,
        });
        let placement = placements.startDispatch(identity);
        for (const step of [
          { to: "provisioning", patch: { environmentId } },
          { to: "syncing", patch: { workerBundleHash: "a".repeat(64) } },
          {
            to: "starting",
            patch: {
              workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
              remoteWorkspaceDir: `/workspace/${index}`,
            },
          },
          { to: "active", patch: { activeOwnerEpoch: 7 } },
        ] as const) {
          placement = placements.transition({
            sessionId: identity.sessionId,
            from: placement.state,
            expectedGeneration: placement.generation,
            ...step,
          });
        }
        if (placement.state !== "active") {
          throw new Error("Expected an active fixture placement");
        }
        reportPlacementTransition(undefined, placement);
        if (index === 255) {
          placements.markWorkspaceResultPending(
            placements.claimTurn({
              ...identity,
              owner: placementTurnOwner(placement),
              claimId: "pending-result",
              runId: "pending-run",
            }),
          );
        }
      }
      const options = {
        client: createSyntheticPluginRuntimeClient({ scopes: [...CLI_DEFAULT_OPERATOR_SCOPES] }),
        context: kernel.gatewayRequestContext,
        methodRegistry: kernel.getAttachedGatewayMethodRegistry(),
      };
      const list = (params: SessionsListParams) =>
        dispatchGatewayRequestInProcess<SessionsListResult>("sessions.list", params, options);
      const before = await list({ archived: false, limit: 1000 });
      expect(before.sessions).toHaveLength(256);
      expect(before.sessions.find((row) => row.sessionId === "live-254")?.placement?.state).toBe(
        "active",
      );
      expect(before.sessions.find((row) => row.sessionId === "live-255")?.placement).toMatchObject({
        state: "active",
        workspaceResultReconciling: true,
      });
      expect(projection.selectEntries().filter(ready)).toHaveLength(256);
      const reads = (["all", "get", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      );
      try {
        for (const [index, { target, entry }] of live.entries()) {
          replaceSessionEntrySync(target, { ...entry, label: `after-${index}` });
        }
        const after = await list({ archived: false, limit: 1000 });
        const expected = structuredClone(before);
        expected.ts = after.ts;
        for (const row of expected.sessions) {
          row.label = row.label?.replace("before-", "after-");
          row.displayName = row.displayName?.replace("before-", "after-");
          row.snapshotAt = after.ts;
        }
        expect(after).toEqual(expected);
        const selects = reads.flatMap((read) =>
          read.mock.contexts.filter(
            (statement): statement is StatementSync =>
              statement instanceof StatementSync &&
              /^select .* from "worker_session_placements"/i.test(statement.sourceSQL),
          ),
        );
        expect(selects.length).toBeLessThanOrEqual(256);
        const batchSizes = selects.map(
          (statement) => statement.sourceSQL.match(/\?/g)?.length ?? 0,
        );
        expect(Math.max(...batchSizes)).toBeLessThanOrEqual(64);
        expect(batchSizes.some((size) => size > 1)).toBe(true);
      } finally {
        for (const read of reads) {
          read.mockRestore();
        }
      }
      holdRenewal = true;
      sessionChanges.emit({ all: true, scope: "catalog" });
      await renewalStarted.promise;
      const pendingPage = await list({ archived: true, limit: 2 });
      expect(pendingPage.sessions.map((row) => row.key)).toEqual([
        "agent:main:archive-127",
        "agent:main:archive-126",
      ]);
      expect(pendingPage.sessions.map((row) => row.contextTokens)).toEqual([8192, 8192]);
      expect(
        projection
          .selectEntries()
          .filter((row) => row.entry.archivedAt !== undefined && ready(row)),
      ).toHaveLength(2);
      reportPlacementTransition(
        undefined,
        placements.startDispatch({
          ...live[0]!.target,
          sessionId: "live-0",
        }),
      );
      const requested = await dispatchGatewayRequestInProcess<{ session: GatewaySessionRow }>(
        "sessions.describe",
        { key: live[0]!.target.sessionKey },
        options,
      );
      expect(requested.session.placement?.state).toBe("requested");
      reportPlacementTransition(
        undefined,
        placements.fail({ sessionId: "live-0", recoveryError: "Current failure" }),
      );
      currentCatalog = catalogFor(16384);
      renewing.resolve(currentCatalog);
      await renewing.promise;
      await projection.ensureMaterialized();
      expect(
        projection
          .selectEntries()
          .filter((row) => row.entry.archivedAt !== undefined && ready(row)),
      ).toHaveLength(0);
      const renewedPage = await list({ archived: true, limit: 2 });
      expect(renewedPage.sessions.map((row) => row.contextTokens)).toEqual([16384, 16384]);
      expect(
        projection
          .selectEntries()
          .filter((row) => row.entry.archivedAt !== undefined && ready(row)),
      ).toHaveLength(2);
      const refreshed = await list({ archived: false, limit: 1000 });
      expect(refreshed.sessions.find((row) => row.sessionId === "live-0")?.placement?.state).toBe(
        "failed",
      );
      expect(
        refreshed.sessions.find((row) => row.sessionId === "live-255")?.placement,
      ).toMatchObject({ state: "active", workspaceResultReconciling: true });
    } finally {
      renewing.resolve(currentCatalog);
      try {
        await kernel?.closeOnStartupFailure();
      } finally {
        releaseBackground();
        catalogRead.mockRestore();
        await state.cleanup();
      }
    }
  });

  it.each([false, true])(
    "services queued tasks after preparing shutdown (cancel: %s)",
    async (cancel) => {
      const port = await getDeterministicFreePortBlock({ offsets: [0] });
      const token = "gateway-startup-fairness-token-1234567890";
      const state = await createOpenClawTestState({
        label: "gateway-startup-fairness",
        layout: "home",
        scenario: "gateway-loopback",
        gateway: { port, token },
        env: {
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          VITEST: "1",
        },
      });
      const events: string[] = [];
      const prepareLifecycle = lifecycleRuntime.prepareGatewayLifecycle;
      const startCore = coreRuntime.startGatewayCoreRuntime;
      let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
      let pendingTask: Promise<void> | undefined;
      vi.spyOn(lifecycleRuntime, "prepareGatewayLifecycle").mockImplementation(async (params) => {
        const prepared = await prepareLifecycle(params);
        events.push("shutdown prepared");
        // Queue in the kernel's timer phase; message-port ordering relative to timers varies.
        pendingTask = delay(0).then(async () => {
          events.push("queued task");
          if (cancel) {
            await prepared.beginClosePrelude();
          }
        });
        void pendingTask.catch(() => {});
        return prepared;
      });
      const start = vi
        .spyOn(coreRuntime, "startGatewayCoreRuntime")
        .mockImplementation(async (params) => {
          events.push("core startup");
          return await startCore(params);
        });
      await runQaGatewayFixture(
        async () => {
          const startup = createGatewayKernel(port, {
            auth: { mode: "token", token },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          }).then((created) => {
            kernel = created;
            return created;
          });
          if (cancel) {
            await expect(startup).rejects.toThrow();
            expect(start).not.toHaveBeenCalled();
            expect(events).toEqual(["shutdown prepared", "queued task"]);
            expect(getActiveGatewayRootWorkCount()).toBe(0);
            expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
          } else {
            kernel = await startup;
            expect(events).toEqual(["shutdown prepared", "queued task", "core startup"]);
            expect(kernel.startupState.dispatchReady).toBe(false);
            expect(kernel.lifecycle.closePreludeStarted).toBe(false);
          }
        },
        async () => {
          await pendingTask;
        },
        async () => {
          await kernel?.closeOnStartupFailure();
        },
        async () => {
          vi.restoreAllMocks();
          await state.cleanup();
        },
      );
    },
  );
});
