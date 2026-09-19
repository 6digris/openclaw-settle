// Planned updates use the existing preserve-only suspension authority before native mutation.
import { randomUUID } from "node:crypto";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type {
  GatewaySuspendPrepareResult,
  GatewaySuspendStatusResult,
  SystemInfoResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { callGateway } from "../../gateway/call.js";
import { createConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import { resolveGatewayLifecycleContext } from "./lifecycle-context.js";
import { resolveGatewayRestartProbeContext } from "./restart-health-probe.js";

export type GatewayUpdateCutover = {
  assertCurrent: () => void;
  refresh: () => Promise<void>;
  release: () => Promise<void>;
};

/** Busy work is deferred, never aborted or described as a durable checkpoint. */
export async function prepareGatewayUpdateCutover(params: {
  expectedPid: number;
  assertCurrent: () => void;
  timeoutMs?: number;
}): Promise<GatewayUpdateCutover> {
  params.assertCurrent();
  if (!Number.isSafeInteger(params.expectedPid) || params.expectedPid <= 0) {
    throw new Error("Update deferred: the serving Gateway process identity is unavailable.");
  }
  const { port, env } = await resolveGatewayLifecycleContext(undefined, true);
  const { config, auth } = await resolveGatewayRestartProbeContext(env);
  const target = await createConfiguredGatewayLocalProbe(config).resolveWebSocketTarget(port);
  if (!target) {
    throw new Error("Update deferred: the serving Gateway TLS identity is unavailable.");
  }
  const authNone = config.gateway?.auth?.mode === "none";
  let bootId: string | undefined;
  const call = <T>(method: string, args: unknown = {}, cleanup = false) => {
    let observedBootId: string | undefined;
    return callGateway<T>({
      config,
      localPortOverride: port,
      token: auth?.token,
      password: auth?.password,
      skipImplicitAuth: true,
      tlsFingerprint: target.tlsFingerprint,
      method,
      params: args,
      scopes: ["operator.admin"],
      clientName: authNone ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
      mode: authNone ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
      requireLocalBackendSharedAuth: authNone,
      deviceIdentity: null,
      sharedStateMode: "read-only",
      timeoutMs: params.timeoutMs ?? 60_000,
      onHelloOk: (hello) => {
        observedBootId = hello.server.bootId;
      },
      assertDispatchCurrent: () => {
        if (!cleanup) {
          params.assertCurrent();
        }
        if (!observedBootId || (bootId && observedBootId !== bootId)) {
          throw new Error("Update deferred: the Gateway connection generation changed.");
        }
        bootId ??= observedBootId;
      },
      requiredMethods: [
        "system.info",
        "gateway.suspend.prepare",
        "gateway.suspend.status",
        "gateway.suspend.handoff",
        "gateway.suspend.resume",
      ],
    });
  };
  const identity = await call<SystemInfoResult>("system.info");
  params.assertCurrent();
  if (identity.pid !== params.expectedPid || !identity.processInstanceId) {
    throw new Error(
      "Update deferred: the serving Gateway process changed or cannot identify its generation.",
    );
  }
  const requestId = `update-${randomUUID()}`;
  let suspensionId: string | undefined;
  let released = false;
  let expiresAtMs = 0;
  let deadline = 0;
  const assertCurrent = () => {
    params.assertCurrent();
    if (released || Date.now() >= expiresAtMs || performance.now() >= deadline) {
      throw new Error("Update deferred: the Gateway cutover preparation expired or was released.");
    }
  };
  const release = async () => {
    released = true;
    if (!suspensionId) {
      return;
    }
    // The token belongs to this preparation; a replacement cannot inherit it.
    const result = await call<{ ok: boolean }>("gateway.suspend.resume", { suspensionId }, true);
    if (!result.ok) {
      throw new Error("Gateway admission restoration is pending; retry after scheduler recovery.");
    }
    suspensionId = undefined;
  };
  const refresh = async () => {
    assertCurrent();
    const state = await call<GatewaySuspendStatusResult>("gateway.suspend.status", {
      suspensionId,
    });
    if (state.status !== "ready") {
      throw new Error("Update deferred: Gateway work is no longer settled.");
    }
    assertCurrent();
    const armed = await call<{ status: string }>("gateway.suspend.handoff", {
      suspensionId,
      target: { pid: identity.pid, processInstanceId: identity.processInstanceId },
    });
    if (armed.status !== "armed") {
      throw new Error("Update deferred: Gateway cutover ownership was refused.");
    }
    assertCurrent();
  };
  const prepareArgs = { requestId, terminalPolicy: "preserve" };
  let prepareReplied = false;
  try {
    const prepared = await call<GatewaySuspendPrepareResult>(
      "gateway.suspend.prepare",
      prepareArgs,
    );
    prepareReplied = true;
    if (prepared.status !== "busy") {
      suspensionId = prepared.suspensionId;
    }
    if (prepared.status !== "ready") {
      throw new Error(
        "Update deferred: active Gateway work cannot be safely interrupted. Retry when it settles.",
      );
    }
    expiresAtMs = prepared.expiresAtMs;
    deadline = performance.now() + Math.max(0, expiresAtMs - Date.now());
    await refresh();
    return { assertCurrent, refresh, release };
  } catch (error) {
    try {
      if (!prepareReplied) {
        // A lost reply does not prove non-execution. Reconcile the same idempotent
        // request against the same boot, then release only its returned token.
        const reconciled = await call<GatewaySuspendPrepareResult>(
          "gateway.suspend.prepare",
          prepareArgs,
          true,
        );
        if (reconciled.status !== "busy") {
          suspensionId = reconciled.suspensionId;
        }
      }
      await release();
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Update deferred; Gateway admission restoration could not be confirmed.",
        { cause: restoreError },
      );
    }
    throw error;
  }
}
