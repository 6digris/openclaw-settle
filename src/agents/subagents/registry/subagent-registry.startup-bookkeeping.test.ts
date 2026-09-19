import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { prepareGatewayPluginBootstrap } from "../../../gateway/server-startup-plugins.js";
import { runStartupSessionMigration } from "../../../gateway/server-startup-session-migration.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { getSubagentRunByRunId } from "./subagent-registry.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "./subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../../../gateway/plugin-activation-runtime-config.js", () => ({
  resolveGatewayStartupPluginActivationConfig: () => {
    throw new Error("plugin activation failed after registry restore");
  },
}));

const cfg: OpenClawConfig = { agents: { list: [{ id: "research", default: true }] } };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;

function seedRun(privateCompletion: boolean, requesterAgentId: string | null = "research") {
  const entry = createSubagentRunRecord({
    runId: "restored-run",
    childSessionKey: "agent:worker:subagent:child",
    requesterSessionKey: requesterAgentId ? "global" : "agent:research:global",
    requesterAgentId: requesterAgentId ?? undefined,
    controllerSessionKey: "global",
    swarmRequesterSessionKey: "global",
    cleanup: "delete",
    endedAt: Date.now(),
    ...(privateCompletion ? { completionTarget: "parent" } : {}),
    completion: { required: true },
    delivery: {
      status: "pending",
      payload: {
        requesterSessionKey: "global",
        requesterDisplayKey: "global",
        childSessionKey: "agent:worker:subagent:child",
        childRunId: "restored-run",
        task: "retained result",
        expectsCompletionMessage: true,
      },
    },
  });
  openOpenClawStateDatabase()
    .db.prepare(
      "INSERT INTO subagent_runs (run_id, child_session_key, controller_session_key, requester_session_key, created_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      entry.runId,
      entry.childSessionKey,
      entry.controllerSessionKey!,
      entry.requesterSessionKey,
      entry.createdAt,
      JSON.stringify(privateCompletion ? { parentCompletion: entry } : entry),
    );
  return entry;
}

function readPhysicalRun() {
  const row = openOpenClawStateDatabase()
    .db.prepare(
      "SELECT requester_session_key, controller_session_key, payload_json FROM subagent_runs WHERE run_id = ?",
    )
    .get("restored-run") as {
    requester_session_key: string;
    controller_session_key: string;
    payload_json: string;
  };
  const stored = JSON.parse(row.payload_json) as SubagentRunRecord & {
    parentCompletion?: SubagentRunRecord;
  };
  return { ...row, entry: stored.parentCompletion ?? stored };
}

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-subagent-startup-bookkeeping-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  resetSubagentRegistryForTests({ persist: false });
  testing.setDepsForTest({ getRuntimeConfig: () => cfg });
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  testing.setDepsForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("subagent startup bookkeeping", () => {
  it.each([false, true])(
    "preserves old-reader reference spellings after later startup failure (private=%s)",
    async (privateCompletion) => {
      const seeded = seedRun(privateCompletion);
      const database = openOpenClawStateDatabase();
      const schema = database.db.prepare("PRAGMA user_version").get();
      await runStartupSessionMigration({ cfg, log });
      expect(fs.existsSync(path.join(stateDir, "agents"))).toBe(false);
      await expect(
        prepareGatewayPluginBootstrap({ cfgAtStart: cfg, minimalTestGateway: false, log }),
      ).rejects.toThrow("plugin activation failed after registry restore");
      expect(getSubagentRunByRunId(seeded.runId)).toMatchObject({
        requesterSessionKey: "agent:research:global",
        controllerSessionKey: "agent:research:global",
        swarmRequesterSessionKey: "agent:research:global",
        delivery: { payload: { requesterSessionKey: "agent:research:global" } },
      });
      const physical = readPhysicalRun();
      expect(physical.entry.archiveAtMs).toBeGreaterThan(seeded.execution.endedAt!);
      expect(physical).toMatchObject({
        requester_session_key: "global",
        controller_session_key: "global",
        entry: {
          requesterSessionKey: "global",
          controllerSessionKey: "global",
          swarmRequesterSessionKey: "global",
          delivery: { payload: { requesterSessionKey: "global" } },
        },
      });
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual(schema);
    },
  );

  it("preserves aliases while startup backfills the known requester owner", async () => {
    seedRun(false, null);
    await expect(
      prepareGatewayPluginBootstrap({ cfgAtStart: cfg, minimalTestGateway: false, log }),
    ).rejects.toThrow("plugin activation failed after registry restore");
    expect(readPhysicalRun()).toMatchObject({
      requester_session_key: "agent:research:global",
      controller_session_key: "global",
      entry: {
        requesterAgentId: "research",
        controllerSessionKey: "global",
        swarmRequesterSessionKey: "global",
        delivery: { payload: { requesterSessionKey: "global" } },
      },
    });
  });

  it.each(["references", "owner"])("persists intentional changed %s", (change) => {
    seedRun(false);
    const runs = loadSubagentRegistryFromSqlite();
    const entry = runs.get("restored-run")!;
    if (change === "references") {
      entry.requesterSessionKey = "agent:research:other";
      entry.controllerSessionKey = "agent:research:other";
      entry.swarmRequesterSessionKey = "agent:research:other";
      entry.delivery!.payload!.requesterSessionKey = "agent:research:other";
    } else {
      entry.requesterAgentId = "operations";
    }
    saveSubagentRegistryChangesToSqlite(runs, [entry.runId]);
    const expected = change === "references" ? "agent:research:other" : "agent:research:global";
    expect(readPhysicalRun()).toMatchObject({
      requester_session_key: expected,
      controller_session_key: expected,
      entry: {
        swarmRequesterSessionKey: expected,
        delivery: { payload: { requesterSessionKey: expected } },
      },
    });
  });
});
