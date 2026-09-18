import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-maintenance.js";

const owned = vi.hoisted(() => ({
  kind: "owned" as const,
  root: "/synthetic/install",
  fingerprint: "recorded-command",
  refreshDefinition: true,
}));

vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  inspectManagedGatewayServiceBeforeUpdate: async () => owned,
}));

beforeEach(mockSystemAccountHome);
afterEach(() => vi.restoreAllMocks());

it.each([
  { name: "OpenClaw Gateway", same: true },
  { name: "\\OpenClaw Gateway", same: true },
  { name: "\\OPENCLAW GATEWAY", same: true },
  { name: "\\Ops\\OpenClaw Gateway", same: false },
  { name: "OpenClaw Gateway Backup", same: false },
])("revalidates the Windows task identity $name", async ({ name, same }) => {
  mockProcessPlatform("win32");
  const home = os.homedir();
  const state: GatewayServiceState = {
    installed: true,
    running: false,
    env: { HOME: home, USERPROFILE: home, OPENCLAW_WINDOWS_TASK_NAME: name },
    command: { programArguments: ["node", "/synthetic/install/openclaw.mjs", "gateway"] },
    loadState: { status: "not-loaded" },
    runtime: { status: "stopped" },
  };
  const result = revalidateManagedGatewayServiceAfterUpdate({
    state,
    root: owned.root,
    preManagedServiceStop: {
      serviceEnv: { HOME: home, USERPROFILE: home, OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" },
      serviceUpdateVerdict: owned,
    },
  });
  if (same) {
    await expect(result).resolves.toEqual(owned);
  } else {
    await expect(result).rejects.toThrow("ownership or manager identity changed");
  }
});
