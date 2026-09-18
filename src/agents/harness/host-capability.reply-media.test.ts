import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { ensureSandboxWorkspaceForSession } from "../sandbox/context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetAgentRunRegistryForTest);

describe("agent harness reply media", () => {
  it("reads reply attachments from the remote sandbox instead of a stale Gateway sandbox", async () => {
    const fixture = tempDirs.make("openclaw-reply-sandbox-");
    const workspaceDir = path.join(fixture, "workspace");
    fs.mkdirSync(workspaceDir);
    const attempt = {
      runId: "run-reply-sandbox",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      cwd: workspaceDir,
      workspaceDir,
      config: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "session",
              workspaceAccess: "ro",
              workspaceRoot: path.join(fixture, "sandboxes"),
            },
          },
        },
      } satisfies OpenClawConfig,
    };
    const sandbox = await ensureSandboxWorkspaceForSession({
      config: attempt.config,
      sessionKey: attempt.sessionKey,
      workspaceDir,
    });
    if (!sandbox) {
      throw new Error("expected configured sandbox workspace");
    }
    fs.writeFileSync(
      path.join(sandbox.workspaceDir, "artifact.txt"),
      "stale Gateway sandbox bytes",
    );
    const host = await createAdmittedHostCapabilityTestFixture(attempt);
    try {
      const readWorkspaceFile = vi.fn(async () => Buffer.from("remote sandbox bytes"));
      const result = await host.hostCapabilities.prepareReplyMedia?.({
        kind: "payload",
        payload: { text: "MEDIA:./artifact.txt" },
        workspaceRoot: "/remote-workspace",
        readWorkspaceFile,
      });
      expect(result?.kind).toBe("payload");
      if (result?.kind !== "payload" || !result.payload.mediaUrl) {
        throw new Error("expected prepared remote attachment");
      }
      expect(fs.readFileSync(result.payload.mediaUrl, "utf8")).toBe("remote sandbox bytes");
      expect(readWorkspaceFile).toHaveBeenCalledOnce();
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });
});
