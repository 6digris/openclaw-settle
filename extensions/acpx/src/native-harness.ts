import { randomUUID } from "node:crypto";
import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "../runtime-api.js";
import type { AcpxNativeTarget } from "./native-types.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";

export function createAcpxNativeHarness(params: {
  id: string;
  label: string;
  agent: string;
  executable: string;
  args: readonly string[];
  api: Pick<OpenClawPluginApi, "config" | "logger"> & {
    runtime: { state: Pick<OpenClawPluginApi["runtime"]["state"], "resolveStateDir"> };
  };
  getRuntime: (context: OpenClawPluginServiceContext) => Promise<CompleteAcpRuntime>;
  cleanupCatalogSession: (sessionId: string, command: readonly string[]) => Promise<void>;
}): AgentHarnessV2 {
  let disposed = false;
  let commandObserved = false;
  let observedCommand: string[] | undefined;
  const active = new Map<string, () => void>();
  const targets = new Map<string, AcpxNativeTarget>();
  const discoverCommand = () =>
    import("openclaw/plugin-sdk/node-host").then(({ resolveNodeHostExecutable }) => {
      const found = resolveNodeHostExecutable(params.executable, { strategy: "direct" });
      observedCommand = found ? [found.executable, ...params.args] : undefined;
      commandObserved = true;
      return observedCommand;
    });
  const runtimeFor = async (workspaceDir?: string) => {
    if (disposed) {
      throw new Error(`${params.label} runtime is closed`);
    }
    const runtime = await params.getRuntime({
      config: params.api.config,
      workspaceDir,
      stateDir: params.api.runtime.state.resolveStateDir(),
      logger: params.api.logger,
    });
    if (disposed || !runtime.native) {
      throw new Error(`${params.label} native runtime is unavailable`);
    }
    return runtime.native;
  };
  const retire = async (
    target: AcpxNativeTarget,
    assertCurrent: () => void,
    discardPersistentState = true,
  ) => {
    active.get(target.sessionId)?.();
    const native = await runtimeFor();
    assertCurrent();
    await native.closeSession(target, assertCurrent, discardPersistentState);
    targets.delete(target.sessionId);
  };
  return {
    id: params.id,
    label: params.label,
    autoSelection: { providerIds: [] },
    authBootstrap: "harness",
    supports: ({ requestedRuntime, modelProvider }) => {
      if (requestedRuntime !== params.id) {
        return { supported: false, reason: "Choose this native runtime explicitly" };
      }
      if (
        modelProvider?.requestTransportOverrides === "present" ||
        modelProvider?.endpointOverrides === "present" ||
        modelProvider?.preparedAuth?.source === "profile" ||
        modelProvider?.preparedAuth?.source === "direct" ||
        (modelProvider?.runtimePolicy !== undefined &&
          !modelProvider.runtimePolicy.compatibleIds.includes(params.id))
      ) {
        return {
          supported: false,
          reason: `${params.label} owns its login and cannot use an OpenClaw credential or custom provider transport`,
        };
      }
      return { supported: true, priority: 100 };
    },
    async loadModelCatalog(input) {
      const command = await discoverCommand();
      if (!command) {
        return [];
      }
      const native = await runtimeFor(input.workspaceDir);
      const target = {
        agentId: input.agentId,
        sessionId: randomUUID(),
        sessionKey: "",
        agent: params.agent,
      };
      let nativeSessionId: string | undefined;
      let discoveryError: unknown;
      try {
        return await native.withSession(
          {
            ...target,
            transient: true,
            command,
            cwd: input.workspaceDir,
            assertActive: () => {
              if (disposed) {
                throw new Error("Native catalog owner retired");
              }
            },
            onSessionCreated: (sessionId) => {
              nativeSessionId = sessionId;
            },
            onPermissionRequest: async () => ({ outcome: "cancel" }),
          },
          async ({ getStatus }) => {
            const status = await getStatus();
            return (status.models?.availableModelIds ?? []).map((id) => {
              const separator = id.indexOf("/");
              if (separator < 1 || separator === id.length - 1) {
                throw new Error(`Native model is missing its provider: ${id}`);
              }
              return {
                provider: id.slice(0, separator),
                id: id.slice(separator + 1),
                name: id,
                nativeRuntime: params.id,
              };
            });
          },
        );
      } catch (error) {
        discoveryError = error;
        throw error;
      } finally {
        const cleanupErrors: unknown[] = [];
        if (nativeSessionId) {
          try {
            await params.cleanupCatalogSession(nativeSessionId, command);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length) {
          const error = new AggregateError(cleanupErrors, "Native catalog cleanup failed");
          if (discoveryError) {
            params.api.logger.error(`Native catalog cleanup also failed: ${String(error)}`);
          } else {
            throw error;
          }
        }
      }
    },
    async runAttempt(input) {
      const command = commandObserved ? observedCommand : await discoverCommand();
      if (!command) {
        throw new Error(`${params.label} is not installed on this Gateway host`);
      }
      const native = await runtimeFor(input.workspaceDir);
      const { runAcpxNativeAttempt } = await import("./native-attempt.js");
      const target = {
        agentId: input.agentId,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        agent: params.agent,
      };
      if (!target.agentId || !target.sessionKey) {
        throw new Error("Native ACP turns require an owned OpenClaw session");
      }
      const ownedTarget = { ...target, agentId: target.agentId, sessionKey: target.sessionKey };
      targets.set(input.sessionId, ownedTarget);
      return runAcpxNativeAttempt({
        input,
        native,
        target: ownedTarget,
        command,
        harnessId: params.id,
        label: params.label,
        active,
      });
    },
    async reset(input) {
      if (!input.sessionId) {
        return;
      }
      const target =
        targets.get(input.sessionId) ??
        (input.agentId && input.sessionKey
          ? {
              agentId: input.agentId,
              sessionId: input.sessionId,
              sessionKey: input.sessionKey,
              agent: params.agent,
            }
          : undefined);
      if (target) {
        await retire(target, () => {});
      }
    },
    async withSessionDeletion(input, run) {
      const target = { ...input, agent: params.agent };
      let committed = false;
      let failed = false;
      try {
        return await run({
          commit() {
            committed = true;
          },
          rollback() {
            committed = false;
          },
        });
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (committed) {
          try {
            await retire(target, input.assertCurrent);
          } catch (error) {
            if (!failed) {
              throw error;
            }
            params.api.logger.error(`Native session cleanup also failed: ${String(error)}`);
          }
        }
      }
    },
    async dispose() {
      for (const cancel of active.values()) {
        cancel();
      }
      for (const target of targets.values()) {
        await retire(target, () => {}, false);
      }
      disposed = true;
    },
  };
}
