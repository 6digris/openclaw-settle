/** Registered Nodes tool -> Gateway handler/registry -> node command -> native fixture. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { wrapToolWithBeforeToolCallHook } from "../../agents/agent-tools.before-tool-call.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createNodesTool } from "../../agents/tools/nodes-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveExecApprovals } from "../../infra/exec-approvals.js";
import { prepareLinuxInstalledApp } from "../../infra/installed-apps-linux.js";
import type { NodeHostClient } from "../../node-host/client.js";
import type { NodeInvokeRequestPayload } from "../../node-host/invoke-types.js";
import { handleInvoke } from "../../node-host/invoke.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureGatewayDeviceRevocation } from "../device-revocation.js";
import { NodeRegistry } from "../node-registry.js";
import { resetNodeWakeStateForTest } from "../node-wake-state.test-support.js";
import { nodeInvokeHandlers } from "../server-methods/nodes.invoke.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { captureTalkVoiceOrigin } from "./client-voice-origin.js";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: mocks.rpc,
  readGatewayCallOptions: () => ({}),
  shouldUseInProcessGatewayTool: () => true,
}));
vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: async () => ({ nodeId: "paired-node", key: "generation" }),
  isNodePairingGenerationCurrent: async () => true,
}));

afterEach(() => {
  clientVoiceSessionTesting.reset();
  resetClientVoiceConfirmationStateForTest();
  resetNodeWakeStateForTest();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.runIf(process.platform === "linux")("registered installed-app voice flow", () => {
  it.each(["launch", "policy-revoked-before-ready", "node-denied"] as const)(
    "first-use inventory and exact launch: %s",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setActivePluginRegistry(createEmptyPluginRegistry());
        const data = state.path("app-data");
        fs.mkdirSync(path.join(data, "applications"), { recursive: true });
        const executable = state.path("native-fixture");
        fs.copyFileSync(process.execPath, executable);
        fs.chmodSync(executable, 0o755);
        fs.writeFileSync(
          path.join(data, "applications", "fixture.desktop"),
          ["[Desktop Entry]", "Type=Application", "Name=Calculator", "Exec=" + executable, ""].join(
            "\n",
          ),
        );
        vi.stubEnv("XDG_DATA_HOME", data);
        vi.stubEnv("XDG_DATA_DIRS", data);
        const app = prepareLinuxInstalledApp("linux-desktop:fixture.desktop")!.app;
        let config: OpenClawConfig = {
          gateway: {
            nodes: {
              commands: {
                allow: ["device.apps.launch"],
                ...(mode === "node-denied" ? { deny: ["device.apps.launch"] } : {}),
              },
            },
          },
          talk: {
            realtime: {
              appLaunchPolicies: [
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
          resolveCurrentPairingState: async () => ({
            identity: "pairing",
            generation: "generation",
          }),
          isPairingStateCurrent: () => true,
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
              permits.push(JSON.parse(event.payload.payloadJSON!));
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
        registry.register(node, {
          pairingIdentity: "pairing",
          pairingGeneration: "generation",
          approvedSurface: { caps: ["device"], commands: ["device.apps", "device.apps.launch"] },
        });
        const context = {
          nodeRegistry: registry,
          getRuntimeConfig: () => config,
          logGateway: { info: vi.fn(), warn: vi.fn() },
        } as unknown as GatewayRequestHandlerOptions["context"];
        mocks.rpc.mockImplementation(
          async (method: string, _options: unknown, params: Record<string, unknown>) => {
            if (method === "node.list") {
              return {
                nodes: registry.listConnected().map((entry) => ({
                  nodeId: entry.nodeId,
                  commands: entry.commands,
                  connected: true,
                })),
              };
            }
            if (method !== "node.invoke") {
              throw new Error("unexpected RPC " + method);
            }
            return await new Promise((resolve, reject) => {
              void Promise.resolve(
                nodeInvokeHandlers["node.invoke"]!({
                  req: { type: "req", id: "app-rpc", method },
                  params,
                  context,
                  client: null,
                  isWebchatConnect: () => false,
                  respond: (ok, payload, error) =>
                    ok
                      ? resolve(payload)
                      : reject(new Error(error?.message ?? "node invocation denied")),
                }),
              ).catch(reject);
            });
          },
        );
        const sessionKey = "agent:main:registered-app";
        const ingress = captureGatewayDeviceRevocation(
          context,
          { deviceId: "widget", role: "operator" },
          () => true,
        );
        const origin = captureTalkVoiceOrigin({
          client: { ...sharingPolicyClient({ deviceId: "widget" }), isDeviceTokenAuth: true },
          hasCurrentClientAuthority: ingress.isCurrent,
        });
        const voiceSessionId = createOrResumeClientVoiceSession({
          agentId: "main",
          sessionKey,
          origin: "client",
          transcriptCapable: true,
          originAuthority: origin,
        });
        ingress.release();
        const admission = prepareSystemAgentRunAdmission(
          config,
          "registered-app-run",
          "main",
          "app-test",
        );
        try {
          const admitted = await admission.admit("embedded");
          registerClientVoiceConsultRun({
            agentId: "main",
            sessionKey,
            voiceSessionId,
            runId: "registered-app-run",
          });
          const tool = wrapToolWithBeforeToolCallHook(
            createNodesTool({ agentId: "main", agentSessionKey: sessionKey, config }),
            { agentId: "main", sessionKey, runId: "registered-app-run" },
          );
          await withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey,
              operationalRunInstance: admitted.operationalRunInstance,
            },
            async () => {
              const listing = await tool.execute("inventory", {
                action: "app_list",
                node: "paired-node",
                query: "Calculator",
              });
              const listed = (
                listing.details as {
                  payload: { apps: Array<{ appId: string; appRevision: string }> };
                }
              ).payload.apps[0]!;
              expect(listed.appId).toBe(app.appId);
              const launching = tool.execute("launch", {
                action: "app_launch",
                node: "paired-node",
                appId: listed.appId,
                appRevision: listed.appRevision,
              });
              if (mode === "launch") {
                const launch = await launching;
                expect(JSON.stringify(launch)).toContain("Installed application launch dispatched");
                expect(permits).toEqual([
                  { type: "installed-app-launch.allow", validForMs: expect.any(Number) },
                ]);
                expect(
                  clientVoiceSessionTesting
                    .readRecord("main", voiceSessionId)
                    ?.effects.find((entry) => entry.toolCallId === "launch")?.voicePolicyId,
                ).toBe("calculator");
              } else {
                await expect(launching).rejects.toThrow(
                  mode === "node-denied"
                    ? /does not advertise|not allow|denied/
                    : /VOICE_CONFIRMATION_REQUIRED/,
                );
                expect(
                  permits.some(
                    (permit) => (permit as { type: string }).type === "installed-app-launch.allow",
                  ),
                ).toBe(false);
              }
            },
          );
          expect(nativeCommands[0]).toBe("device.apps");
          if (mode === "node-denied") {
            expect(nativeCommands).toEqual(["device.apps"]);
          }
        } finally {
          admission.close();
          registry.unregister("node-connection");
          await Promise.all(pending);
        }
      });
    },
  );
});
