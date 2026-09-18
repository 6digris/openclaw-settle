import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  readWorkspaceSkillResources,
  resolveWorkspaceWorkerArgv,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
} from "openclaw/plugin-sdk/plugin-entry";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/security-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { evaluateFileReadPolicySnapshot } from "../shared/policy.js";
import { readWorkspaceMemoryRequest } from "../shared/workspace-memory-request.js";
import { readWorkspaceSkillsRequest } from "../shared/workspace-skills-request.js";

/** Run the same packaged file worker used by SSH adapters; never run arbitrary argv. */
export function createWorkspaceMemoryCommand(
  api: OpenClawPluginApi,
): OpenClawPluginNodeHostCommand {
  return createWorkspaceCommand(api, "memory");
}

export function createWorkspaceSkillsCommand(
  api: OpenClawPluginApi,
): OpenClawPluginNodeHostCommand {
  return createWorkspaceCommand(api, "skills");
}

function createWorkspaceCommand(
  api: OpenClawPluginApi,
  kind: "memory" | "skills",
): OpenClawPluginNodeHostCommand {
  return {
    command: `workspace.${kind}`,
    cap: "file",
    dangerous: true,
    duplex: true,
    async handle(paramsJSON, io) {
      if (!io?.frames) {
        throw new Error("Workspace workers require node duplex transport");
      }
      const params = JSON.parse(paramsJSON ?? "{}");
      const request =
        kind === "memory" ? readWorkspaceMemoryRequest(params) : readWorkspaceSkillsRequest(params);
      const maxReplyBytes = params.maxReplyBytes;
      if (
        maxReplyBytes !== undefined &&
        (!Number.isSafeInteger(maxReplyBytes) || maxReplyBytes < 0)
      ) {
        throw new Error("Invalid workspace response byte limit");
      }
      const agents = api.config.agents?.list?.map((agent) => agent.id) ?? ["main"];
      const configured = agents.some(
        (agentId) =>
          path.resolve(api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId)) ===
          request.workspaceDir,
      );
      if (!configured) {
        throw new Error("Workspace does not belong to this node");
      }
      // Keep the existing file-node no-alias policy; native Memory still owns file IO.
      for (const access of request.paths) {
        if ((await canonicalPathFromExistingAncestor(access.path)) !== access.path) {
          throw new Error("Node workspace paths must use their canonical location");
        }
      }
      io.signal.throwIfAborted();
      let start!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      const unsubscribe = io.frames.onMessage((message) => {
        if (Buffer.from(message).toString("utf8") !== "start") {
          throw new Error("Unexpected workspace worker input");
        }
        start();
      });
      const abortStart = () => start();
      io.signal.addEventListener("abort", abortStart, { once: true });
      try {
        await started;
        io.signal.throwIfAborted();
        if (kind === "skills" && params.operation === "readResources") {
          const policy = asOptionalRecord(params.resourceReadPolicy);
          const pluginConfig = asOptionalRecord(policy?.pluginConfig);
          if (typeof policy?.nodeId !== "string" || !pluginConfig) {
            throw new Error("Skill bundle requires a Gateway file read policy");
          }
          const nodeId = policy.nodeId;
          // SAFETY: The same-version adapter sends the native Skill; request admission checked its root.
          const input = JSON.parse(request.request) as {
            skill: Parameters<typeof readWorkspaceSkillResources>[0];
            allowMissingRoot: boolean;
          };
          const files = await readWorkspaceSkillResources(input.skill, {
            allowMissingRoot: input.allowMissingRoot,
            assertFileAccess(requestedPath, canonicalPath) {
              io.signal.throwIfAborted();
              for (const filePath of new Set([requestedPath, canonicalPath])) {
                const decision = evaluateFileReadPolicySnapshot({
                  nodeId,
                  pluginConfig,
                  path: filePath,
                });
                if (
                  !decision.ok ||
                  decision.reason === "ask-always" ||
                  (!decision.followSymlinks && requestedPath !== canonicalPath)
                ) {
                  throw new Error("Skill resource is denied by the node file read policy");
                }
              }
            },
          });
          const bytes = Buffer.from(`${JSON.stringify(files)}\n`);
          if (maxReplyBytes !== undefined && bytes.byteLength > maxReplyBytes) {
            throw new Error("Workspace response exceeds the node file policy byte limit");
          }
          io.signal.throwIfAborted();
          await io.frames.send(bytes);
          return JSON.stringify({ ok: true });
        }
        const child = spawn(
          process.execPath,
          [
            ...resolveWorkspaceWorkerArgv(kind),
            ...(kind === "memory"
              ? [request.watch ? "--watch-files" : "--files", request.workspaceDir]
              : [request.workspaceDir, os.homedir(), readWorkspaceSkillsRequest(params).operation]),
          ],
          {
            cwd: request.workspaceDir,
            env: { HOME: os.homedir(), PATH: process.env.PATH },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const exited = new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`Workspace worker exited with ${code}`)),
          );
        });
        void exited.catch(() => {});
        child.stderr.on("data", (bytes: Buffer) =>
          api.logger.warn(bytes.toString("utf8").trimEnd()),
        );
        child.stdin.on("error", () => child.kill("SIGTERM"));
        const stop = () => {
          child.kill("SIGTERM");
        };
        io.signal.addEventListener("abort", stop, { once: true });
        try {
          io.signal.throwIfAborted();
          if (request.watch) {
            child.stdin.write(`${request.request.trimEnd()}\n`);
          } else {
            child.stdin.end(request.request);
          }
          let bytesSent = 0;
          for await (const bytes of child.stdout) {
            io.signal.throwIfAborted();
            bytesSent += bytes.byteLength;
            if (!request.watch && maxReplyBytes !== undefined && bytesSent > maxReplyBytes) {
              throw new Error("Workspace response exceeds the node file policy byte limit");
            }
            await io.frames.send(bytes);
          }
          await exited;
          return JSON.stringify({ ok: true });
        } finally {
          io.signal.removeEventListener("abort", stop);
          child.stdin.destroy();
          child.kill("SIGTERM");
          await exited.catch(() => {});
        }
      } finally {
        io.signal.removeEventListener("abort", abortStart);
        unsubscribe();
      }
    },
  };
}
