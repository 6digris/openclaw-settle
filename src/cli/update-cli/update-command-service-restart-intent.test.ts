import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));

beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "publishes native update restart intent and clears failed stops (fails=%s)",
  (fails) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      const serviceEnv = {
        HOME: home,
        OPENCLAW_PROFILE: "secondary",
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw-secondary"),
        OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-secondary", "openclaw.json"),
      };
      createUpdateRun({ runId: randomUUID(), trigger: "cli" }, { env: serviceEnv });
      const readIntent = () => {
        const db = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(serviceEnv), {
          readOnly: true,
        });
        try {
          return db
            .prepare(
              "SELECT pid, reason FROM gateway_restart_intent WHERE intent_key = 'gateway-restart'",
            )
            .get();
        } finally {
          db.close();
        }
      };
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: serviceEnv,
        }),
        readRuntime: async () => ({
          status: "running",
          pid: 424242,
          systemd: { managerUid: 2001 },
        }),
        isLoaded: async () => true,
        stop: vi.fn(async ({ env }) => {
          expect(env.OPENCLAW_STATE_DIR).toBe(serviceEnv.OPENCLAW_STATE_DIR);
          expect(readIntent()).toEqual({ pid: 424242, reason: null });
          if (fails) {
            throw new Error("native stop failed");
          }
        }),
      });
      mocks.service.mockReturnValue(service);
      const stopping = maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "prepare",
        jsonMode: true,
        expectedService: { serviceEnv },
      });
      if (fails) {
        await expect(stopping).rejects.toThrow("native stop failed");
        expect(readIntent()).toBeUndefined();
      } else {
        await expect(stopping).resolves.toMatchObject({ stopped: true });
      }
      expect(service.stop).toHaveBeenCalledOnce();
    }),
);
