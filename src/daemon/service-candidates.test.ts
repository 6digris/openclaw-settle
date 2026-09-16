import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as serviceInventory from "./inspect.js";
import { readGatewayServiceCandidates } from "./service.js";
import {
  createMockGatewayService as createService,
  mockSystemAccountHome,
} from "./service.test-helpers.js";

beforeEach(mockSystemAccountHome);
afterEach(() => vi.restoreAllMocks());

describe("readGatewayServiceCandidates", () => {
  it("inspects a custom Windows task name before deciding installation relevance", async () => {
    mockProcessPlatform("win32");
    const taskName = "\\OpenClaw Gateway Backup";
    vi.spyOn(serviceInventory, "findGatewayServices").mockResolvedValue({
      services: [
        {
          platform: "win32",
          label: taskName,
          detail: `task: ${taskName}`,
          scope: "system",
          marker: "openclaw",
        },
      ],
      errors: [],
    });
    const command = {
      programArguments: ["C:\\Node\\node.exe", "C:\\OtherInstall\\openclaw.mjs", "gateway"],
      sourcePath: "C:\\Services\\Backup\\gateway.cmd",
      environment: {
        OPENCLAW_PROFILE: "default",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Backup",
        OPENCLAW_STATE_DIR: "C:\\Services\\Backup",
        OPENCLAW_CONFIG_PATH: "C:\\Services\\Backup\\openclaw.json",
      },
    };
    const service = createService({
      isLoaded: vi.fn(async () => true),
      readCommand: vi.fn(async () => command),
    });
    await expect(
      readGatewayServiceCandidates(service, {
        env: { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "unrelated" },
      }),
    ).resolves.toMatchObject([
      {
        installed: true,
        command,
        env: { ...command.environment, OPENCLAW_WINDOWS_TASK_NAME: taskName },
      },
    ]);
    expect(service.readCommand).toHaveBeenCalledWith(
      expect.objectContaining({ OPENCLAW_WINDOWS_TASK_NAME: taskName }),
      expect.objectContaining({ requireEffective: true, requireLoaded: true }),
    );
    expect(service.readRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ ...command.environment, OPENCLAW_WINDOWS_TASK_NAME: taskName }),
      expect.objectContaining({ requireLoaded: true }),
    );
  });
});
