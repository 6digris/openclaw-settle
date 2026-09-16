import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";
import type { SessionPlacementTurnParams } from "./session-placement-admission.js";
import type { AnyAgentTool } from "./tools/common.js";

/** A host-owned binding; callers still enforce their own allowed files and operations. */
export type AgentWorkspaceAccess = {
  bridge: SandboxFsBridge;
  /** Native memory maintenance; separate from owner document edit permissions. */
  memoryBridge?: Pick<
    SandboxFsBridge,
    "readFile" | "writeFile" | "mkdirp" | "stat" | "listDirectory"
  >;
  /** Transfer admitted originals and return the existing private input-directory note. */
  prepareTurnAttachments?: (
    turn: Pick<
      SessionPlacementTurnParams,
      "abortSignal" | "config" | "media" | "timeoutMs" | "userTurnTranscriptRecorder"
    >,
    assertCurrent: () => void,
  ) => Promise<string | undefined>;
  /** Execute the existing memory tools beside the authoritative workspace/index. */
  executeMemoryTool?: (
    name: "memory_search" | "memory_get",
    ...args: Parameters<AnyAgentTool["execute"]>
  ) => ReturnType<AnyAgentTool["execute"]>;
  /** Acquire the native memory manager beside the authoritative workspace/index. */
  getMemorySearchManager?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
    inspectSources?: boolean;
  }) => Promise<MemorySearchManager>;
};

const bindings = new Map<string, { access?: AgentWorkspaceAccess; active: boolean }>();

/** Declare remote ownership before services start; unavailable access must not fall back locally. */
export function declareAgentWorkspaceAccess(workspaceDir: string): void {
  const key = path.resolve(workspaceDir);
  if (!bindings.has(key)) {
    bindings.set(key, { active: false });
  }
}

/** Bind a provisioned workspace for the Gateway service lifetime, independently of agent runs. */
export function registerAgentWorkspaceAccess(
  workspaceDir: string,
  access: AgentWorkspaceAccess,
): () => void {
  const key = path.resolve(workspaceDir);
  if (bindings.get(key)?.active) {
    throw new Error(`Workspace access is already registered: ${key}`);
  }
  const binding = { access, active: true };
  bindings.set(key, binding);
  return () => {
    // Revocation must not turn a remote workspace into a local fallback.
    binding.active = false;
  };
}

export function getAgentWorkspaceAccess(workspaceDir: string): AgentWorkspaceAccess | undefined {
  const binding = bindings.get(path.resolve(workspaceDir));
  if (binding && !binding.active) {
    throw new Error("Workspace access is stopped or not ready");
  }
  return binding?.access;
}

/** Preserve original media/transcript facts; only the executing harness needs the remote note. */
export async function prepareAgentWorkspaceTurn(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptParams> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (!access) {
    return params;
  }
  if (!access.prepareTurnAttachments) {
    throw new Error("Remote workspace attachment preparation is unavailable");
  }
  const assertCurrent = () => {
    params.abortSignal?.throwIfAborted();
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace access changed during attachment preparation");
    }
  };
  assertCurrent();
  const note = await access.prepareTurnAttachments(
    {
      config: params.config,
      media: params.media,
      timeoutMs: params.timeoutMs,
      abortSignal: params.abortSignal,
      userTurnTranscriptRecorder: params.userTurnTranscriptRecorder,
    },
    assertCurrent,
  );
  assertCurrent();
  return note
    ? {
        ...params,
        prompt: `${params.prompt}\n\n${note}`,
        transcriptPrompt: params.transcriptPrompt ?? params.prompt,
      }
    : params;
}
