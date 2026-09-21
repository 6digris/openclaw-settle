import { execFileSync } from "node:child_process";
/** Real policy recorder/router/node command and native ELF effect. Only the node wire is in-memory. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureNodePairingState,
  resolveCurrentPairedDeviceNodeBinding,
  isPairedDeviceNodeBindingCurrent,
} from "../../infra/device-pairing-node-state.js";
import { requestNodePairing, approveNodePairing } from "../../infra/device-pairing-node.js";
import { seedNodeDevice } from "../../infra/device-pairing-node.test-support.js";
import { saveExecApprovals } from "../../infra/exec-approvals.js";
import { prepareLinuxInstalledApp } from "../../infra/installed-apps-linux.js";
import type { NodeHostClient } from "../../node-host/client.js";
import type { NodeInvokeRequestPayload } from "../../node-host/invoke-types.js";
import { handleInvoke } from "../../node-host/invoke.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { NodeRegistry } from "../node-registry.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";

export async function createNativeAppPolicyFixture(
  state: OpenClawTestState,
  mode: "launch" | "policy-revoked-before-ready" | "node-denied" | "unapproved" = "launch",
  onPermit?: () => void,
) {
  const data = state.path("app-data");
  fs.mkdirSync(path.join(data, "applications"), { recursive: true });
  const executable = state.path("native-fixture");
  const marker = state.path("native-effects");
  const c = state.path("native-fixture.c");
  fs.writeFileSync(
    c,
    "#include <stdio.h>" +
      String.fromCharCode(10) +
      "int main(int argc,char**argv){if(argc!=1)return 2;FILE*f=fopen(" +
      JSON.stringify(marker) +
      ',"a");if(!f)return 3;fputs("effect",f);fputc(10,f);return fclose(f);}',
  );
  execFileSync("gcc", [c, "-o", executable]);
  fs.writeFileSync(
    path.join(data, "applications", "fixture.desktop"),
    ["[Desktop Entry]", "Type=Application", "Name=Calculator", "Exec=" + executable, ""].join("\n"),
  );
  vi.stubEnv("XDG_DATA_HOME", data);
  vi.stubEnv("XDG_DATA_DIRS", data);
  const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
  let config: OpenClawConfig = {
    gateway: {
      nodes: {
        commands: {
          allow: ["device.apps", "device.apps.launch"],
          ...(mode === "node-denied" ? { deny: ["device.apps.launch"] } : {}),
        },
      },
    },
    talk: {
      realtime: {
        appLaunchPolicies:
          mode === "unapproved"
            ? []
            : [
                {
                  id: "calculator",
                  agentId: "main",
                  originatingDeviceId: "widget",
                  nodeId: "paired-node",
                  appId: app.appId,
                  appRevision: app.appRevision,
                  expiresAtMs: Date.now() + 60000,
                },
              ],
      },
    },
  };
  setRuntimeConfigSnapshot(config, config);
  saveExecApprovals({
    version: 1,
    agents: {
      main: { security: "allowlist", ask: "off", allowlist: [{ pattern: executable }] },
    },
  });
  const registry = new NodeRegistry({
    getConfig: () => config,
    resolveCurrentPairingState: resolveCurrentPairedDeviceNodeBinding,
    isPairingStateCurrent: isPairedDeviceNodeBindingCurrent,
  });
  const invocations = new Map<
    string,
    { controller: AbortController; input?: (raw: string) => void; seq: number }
  >();
  const nativeCommands: string[] = [];
  const permits: unknown[] = [];
  const pending = new Set<Promise<void>>();
  class Transport extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    close() {
      this.readyState = 3;
    }
    terminate() {
      this.close();
    }
    send(raw: string) {
      const event = JSON.parse(raw) as {
        event: string;
        payload: NodeInvokeRequestPayload & { invokeId?: string; payloadJSON?: string };
      };
      if (event.event === "node.invoke.input") {
        const permit = JSON.parse(event.payload.payloadJSON!);
        permits.push(permit);
        if (permit.type === "installed-app-launch.allow") {
          onPermit?.();
        }
        invocations.get(event.payload.id)?.input?.(event.payload.payloadJSON!);
        return;
      }
      if (event.event === "node.invoke.cancel") {
        invocations.get(event.payload.id)?.controller.abort();
        return;
      }
      if (event.event !== "node.invoke.request") {
        return;
      }
      const frame = event.payload;
      const active = {
        controller: new AbortController(),
        input: undefined as ((raw: string) => void) | undefined,
        seq: 0,
      };
      invocations.set(frame.id, active);
      nativeCommands.push(frame.command);
      const request: NodeHostClient["request"] = async (method, value) => {
        if (method === "node.invoke.result") {
          registry.handleInvokeResult({
            ...(value as Parameters<NodeRegistry["handleInvokeResult"]>[0]),
            connId: "node-connection",
          });
        }
        return {} as never;
      };
      const operation = Promise.resolve()
        .then(() =>
          handleInvoke(frame, { request }, { current: async () => [] }, undefined, {
            installedAppsSharingEnabled: true,
            installedAppsPlatform: "linux",
            signal: active.controller.signal,
            pluginCommandIo: {
              signal: active.controller.signal,
              onInput: (listener) => {
                active.input = listener;
              },
              emitChunk: async (chunk) => {
                if (mode === "policy-revoked-before-ready") {
                  config = {
                    ...config,
                    talk: {
                      ...config.talk,
                      realtime: { ...config.talk?.realtime, appLaunchPolicies: [] },
                    },
                  };
                  setRuntimeConfigSnapshot(config, config);
                }
                registry.handleInvokeProgress({
                  invokeId: frame.id,
                  nodeId: "paired-node",
                  connId: "node-connection",
                  seq: active.seq++,
                  chunk,
                });
              },
            },
          }),
        )
        .catch((error: unknown) => {
          registry.handleInvokeResult({
            id: frame.id,
            nodeId: "paired-node",
            connId: "node-connection",
            ok: false,
            error: { code: "REFUSED", message: String(error) },
          });
        })
        .finally(() => {
          invocations.delete(frame.id);
          pending.delete(operation);
        });
      pending.add(operation);
    }
  }
  const node: GatewayWsClient = {
    socket: new Transport(),
    connId: "node-connection",
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      role: "node",
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        deviceFamily: "linux",
        mode: "node",
      },
      device: {
        id: "paired-node",
        publicKey: "fixture",
        signature: "fixture",
        signedAt: 1,
        nonce: "fixture",
      },
      caps: ["device"],
      commands: ["device.apps", "device.apps.launch"],
    },
  };
  await seedNodeDevice(state.stateDir, "paired-node");
  const surface = await requestNodePairing(
    {
      nodeId: "paired-node",
      platform: "linux",
      caps: ["device"],
      commands: ["device.apps", "device.apps.launch"],
    },
    state.stateDir,
  );
  await approveNodePairing(
    surface.request.requestId,
    { callerScopes: ["operator.admin", "operator.pairing"] },
    state.stateDir,
  );
  const pairing = await captureNodePairingState("paired-node", state.stateDir);
  if (!pairing) {
    throw new Error("Missing actual paired node state");
  }
  registry.register(node, {
    pairingIdentity: pairing.identity.key,
    pairingGeneration: pairing.generation?.key,
    approvedSurface: { caps: ["device"], commands: ["device.apps", "device.apps.launch"] },
  });
  const context = {
    nodeRegistry: registry,
    trackExecution: (run: () => Promise<void>) => run(),
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    getRuntimeConfig: () => config,
    logGateway: { info: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];

  const ingress = captureGatewayDeviceRevocation(
    context,
    { deviceId: "widget", role: "operator" },
    () => true,
  );
  const origin = captureTalkVoiceOrigin({
    client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
    hasCurrentClientAuthority: ingress.isCurrent,
  });
  ingress.release();
  return {
    app,
    config: () => config,
    context,
    origin,
    nativeCommands,
    permits,
    effectCount: () =>
      fs.existsSync(marker)
        ? fs.readFileSync(marker, "utf8").split(String.fromCharCode(10)).filter(Boolean).length
        : 0,
    close: async () => {
      origin?.release();
      registry.unregister("node-connection");
      await Promise.all(pending);
    },
  };
}
