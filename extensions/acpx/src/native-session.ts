import { isDeepStrictEqual } from "node:util";
import {
  ACPX_BACKEND_ID,
  AcpxRuntime as BaseAcpxRuntime,
  encodeAcpxRuntimeHandleState,
  type AcpRuntimeOptions,
} from "acpx/runtime";
import type { AcpRuntimeHandle } from "../runtime-api.js";
import type {
  AcpxNativeRuntime,
  AcpxNativeSessionInput,
  AcpxNativeTarget,
} from "./native-types.js";
import type { CompleteAcpRuntime } from "./runtime-proxy.js";
import { resolveAcpxSessionResource } from "./session-resource.js";

export type AcpxSessionDelegate = {
  delegate: BaseAcpxRuntime;
  native?: { input?: AcpxNativeSessionInput; command: string[] };
};

type AcpxNativeSessionOwner = {
  runtime: CompleteAcpRuntime;
  sessionStore: AcpRuntimeOptions["sessionStore"];
  options: AcpRuntimeOptions;
  testOptions: ConstructorParameters<typeof BaseAcpxRuntime>[1];
  delegates: Map<string, AcpxSessionDelegate>;
  serialize<T>(key: string, run: () => Promise<T>): Promise<T>;
  ensure: CompleteAcpRuntime["ensureSession"];
  setModel(handle: AcpRuntimeHandle, model: string): Promise<unknown>;
  getStatus: AcpxNativeRuntime["getStatus"];
  mcpServers(input: AcpxNativeSessionInput): AcpRuntimeOptions["mcpServers"];
  transient: AcpxNativeRuntime["withSession"];
};

function nativeSessionTarget(input: AcpxNativeTarget) {
  // Qualified resources survive restart without an ACP control-plane locator proving a bare key.
  return {
    agentId: input.agentId,
    sessionKey: `agent:${input.agentId}:harness:${input.agent}:${input.sessionId}`,
  };
}

export function createAcpxNativeRuntime(owner: AcpxNativeSessionOwner): AcpxNativeRuntime {
  return {
    withSession: async (input, run) => {
      if (input.transient) {
        return owner.transient(input, run);
      }
      const target = nativeSessionTarget(input);
      const resource = resolveAcpxSessionResource(target);
      return owner.serialize(resource, async () => {
        input.assertActive();
        let scoped = owner.delegates.get(resource);
        if (!scoped) {
          const native: { input?: AcpxNativeSessionInput; command: string[] } = {
            command: [...input.command],
          };
          const delegate = new BaseAcpxRuntime(
            {
              ...owner.options,
              permissionMode: "deny-all",
              nonInteractivePermissions: "deny",
              mcpServers: owner.mcpServers(input),
              onPermissionRequest: async (request, context) => {
                const active = native.input;
                if (!active || context.signal.aborted) {
                  return { outcome: "cancel" };
                }
                try {
                  active.assertActive();
                  const result = await active.onPermissionRequest(request, context);
                  active.assertActive();
                  return native.input === active && !context.signal.aborted
                    ? result
                    : { outcome: "cancel" };
                } catch {
                  return { outcome: "cancel" };
                }
              },
            },
            owner.testOptions,
          );
          scoped = { delegate, native };
          owner.delegates.set(resource, scoped);
        }
        if (!scoped.native || !isDeepStrictEqual(scoped.native.command, input.command)) {
          throw new Error(
            "Native ACP session command changed; reset this session before continuing",
          );
        }
        scoped.native.input = input;
        try {
          const handle = await owner.ensure({
            ...target,
            agent: input.agent,
            mode: "persistent",
            cwd: input.cwd,
            ...(input.model ? { model: input.model, modelExplicit: true } : {}),
          });
          input.onSessionCreated?.(handle.backendSessionId);
          try {
            input.assertActive();
          } catch (error) {
            await owner.runtime.close({
              handle,
              reason: "native-admission-revoked",
              discardPersistentState: false,
            });
            throw error;
          }
          const record = await owner.sessionStore.load(resource);
          input.assertActive();
          if (
            input.model &&
            (await owner.getStatus(handle)).models?.currentModelId !== input.model
          ) {
            input.assertActive();
            await owner.setModel(handle, input.model);
            input.assertActive();
          }
          return await run({
            runtime: owner.runtime,
            handle,
            lastRequestId: record?.lastRequestId,
            getStatus: () => owner.getStatus(handle),
          });
        } finally {
          scoped.native.input = undefined;
        }
      });
    },
    closeSession: async (input, assertCurrent, discardPersistentState = true) => {
      const target = nativeSessionTarget(input);
      const resource = resolveAcpxSessionResource(target);
      await owner.serialize(resource, async () => {
        assertCurrent();
        const record = await owner.sessionStore.load(resource);
        assertCurrent();
        if (!record) {
          return;
        }
        const handle = {
          ...target,
          backend: ACPX_BACKEND_ID,
          cwd: record.cwd,
          acpxRecordId: record.acpxRecordId,
          backendSessionId: record.acpSessionId,
          agentSessionId: record.agentSessionId,
          runtimeSessionName: encodeAcpxRuntimeHandleState({
            name: resource,
            agent: input.agent,
            cwd: record.cwd,
            mode: "persistent",
            acpxRecordId: record.acpxRecordId,
            backendSessionId: record.acpSessionId,
            agentSessionId: record.agentSessionId,
          }),
        };
        await owner.runtime.close({
          handle,
          reason: "native-session-retired",
          discardPersistentState,
        });
        assertCurrent();
      });
    },
    getStatus: owner.getStatus,
  };
}
