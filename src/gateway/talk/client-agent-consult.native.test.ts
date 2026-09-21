/** Real native app-server requests cross the production dynamic-tool and host boundaries.
 * Only inference, model selection, and the final Gateway method receiver are fixtures.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_VERSION,
  createCodexDynamicToolBridge,
  readCodexDynamicToolCallParams,
  createCodexNativeTestState,
  createIsolatedCodexAppServerClient,
} from "../../../extensions/codex/test-api.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import {
  createGatewayToolCallerWrapper,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { shouldUseInProcessGatewayTool } from "../../agents/tools/gateway.js";
import { createNodesTool } from "../../agents/tools/nodes-tool.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { consultRealtimeVoiceAgent } from "../../talk/agent-consult-runtime.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  resolveOpenClientVoiceSessionId,
} from "../../talk/client-voice-session.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "../server-methods/types.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";

type Consult = typeof consultRealtimeVoiceAgent;
type CoreRun = typeof import("../../agents/embedded-agent.js").runEmbeddedAgent;
const mocks = vi.hoisted(() => ({
  run: vi.fn<CoreRun>(),
  consult: vi.fn<Consult>(),
  dispatch: vi.fn<(options: GatewayRequestOptions) => Promise<void>>(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.run }));
vi.mock("../../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: mocks.consult,
}));
vi.mock("../server-methods.js", () => ({ handleGatewayRequest: mocks.dispatch }));
afterEach(() => vi.clearAllMocks());

it.each([
  "logical-close",
  "transport-replacement",
  "logical-close-owned",
  "transport-replacement-owned",
  "closed-before-admission",
  "cancelled",
  "gateway-retired",
  "gateway-replaced",
  "source-revoked",
  "execution-replaced",
] as const)(
  "preserves accepted native execution and fences its execution owner: %s",
  { timeout: 90_000 },
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const native = await createCodexNativeTestState(state.path("native"));
      const runId = "native-launch-repro";
      const controller = new AbortController();
      const detachOnly =
        mode.startsWith("logical-close") || mode.startsWith("transport-replacement");
      let owner: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      let createOwner: (() => ReturnType<typeof createTalkClientGatewayControlOwner>) | undefined;
      const sessionKey = "agent:main:native-launch-proof";
      const sessionId = "native-launch-proof";
      const voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        transcriptCapable: true,
      });
      const gateway = {
        trackExecution: (run) => run(),
        getRuntimeConfig: () => ({}),
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      } as GatewayRequestContext;
      let currentGateway: GatewayRequestContext | undefined = gateway;
      const context = {
        broadcastToConnIds: vi.fn(),
        chatAbortControllers: new Map(),
        logGateway: createSubsystemLogger("native-talk-test"),
        resolveGatewayContext: () => currentGateway,
      } as Pick<
        GatewayRequestContext,
        "chatAbortControllers" | "logGateway" | "resolveGatewayContext" | "broadcastToConnIds"
      >;
      const operands: Array<{ run: boolean; inProcess: boolean; resolver: boolean }> = [];
      const received: string[] = [];
      mocks.dispatch.mockImplementation(async ({ req, client, context: receiver, respond }) => {
        expect(receiver).toBe(gateway);
        const identity = client?.internal?.agentRuntimeIdentity;
        if (req.method === "node.invoke") {
          expect(identity?.operationalRunInstance?.runId).toBe(runId);
          expect(identity && gateway.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
        }
        received.push(req.method);
        if (req.method === "node.list") {
          respond(true, {
            nodes: [
              {
                nodeId: "paired-fixture",
                connected: true,
                commands: ["device.apps", "device.apps.launch"],
              },
            ],
          });
        } else if (req.method === "node.invoke") {
          respond(true, { ok: true });
        } else {
          throw new Error("Unexpected fixture method: " + req.method);
        }
      });
      let requests = 0;
      const server = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          const item =
            requests++ % 2 === 0
              ? {
                  type: "function_call",
                  call_id: "launch-" + requests,
                  name: "nodes",
                  arguments: JSON.stringify({
                    action: "app_launch",
                    node: "paired-fixture",
                    appId: "linux-desktop:fixture.desktop",
                    appRevision: "a".repeat(64),
                  }),
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: "answer-" + requests,
                  content: [{ type: "output_text", text: "done" }],
                };
          const events = [
            { type: "response.created", response: { id: "r" + requests } },
            { type: "response.output_item.done", item },
            {
              type: "response.completed",
              response: {
                id: "r" + requests,
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              },
            },
          ];
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            events
              .map(
                (event) =>
                  "event: " +
                  event.type +
                  String.fromCharCode(10) +
                  "data: " +
                  JSON.stringify(event) +
                  String.fromCharCode(10, 10),
              )
              .join(""),
          );
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing fixture address");
      }
      await fs.writeFile(
        path.join(native.codexHome, "config.toml"),
        [
          'model="fixture"',
          'model_provider="fixture"',
          'cli_auth_credentials_store="ephemeral"',
          'web_search="disabled"',
          'approval_policy="never"',
          'sandbox_mode="read-only"',
          "[features]",
          "shell_snapshot=false",
          "code_mode=false",
          "[analytics]",
          "enabled=false",
          "[feedback]",
          "enabled=false",
          "[model_providers.fixture]",
          'name="Local fixture"',
          'base_url="http://127.0.0.1:' + address.port + '/v1"',
          'wire_api="responses"',
          "requires_openai_auth=false",
          "supports_websockets=false",
          "request_max_retries=0",
          "stream_max_retries=0",
        ].join(String.fromCharCode(10)),
      );
      const env = Object.fromEntries(
        Object.entries(native.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      let client: Awaited<ReturnType<typeof createIsolatedCodexAppServerClient>> | undefined;
      let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
      let admission: PreparedAgentRunAdmission | undefined;
      let replacementAdmission: PreparedAgentRunAdmission | undefined;
      let bridge: ReturnType<typeof createCodexDynamicToolBridge> | undefined;
      const results: Awaited<ReturnType<NonNullable<typeof bridge>["handleToolCall"]>>[] = [];
      let completed = createDeferred<unknown>();
      let threadId = "";
      const nativeTurn = async () => {
        completed = createDeferred<unknown>();
        if (!client) {
          throw new Error("Missing native client");
        }
        await client.request(
          "turn/start",
          { threadId, input: [{ type: "text", text: "Open fixture", text_elements: [] }] },
          { timeoutMs: 20_000 },
        );
        await withTestTimeout(completed.promise, 30_000, "Native tool turn did not complete");
      };
      try {
        client = await createIsolatedCodexAppServerClient({
          startOptions: {
            transport: "stdio",
            command: native.command,
            commandSource: "config",
            args: ["app-server"],
            cwd: native.cwd,
            headers: {},
            env,
            clearEnv: Object.keys(process.env).filter((key) => !(key in env)),
          },
          agentDir: state.agentDir(),
          authProfileId: null,
          config: {},
          timeoutMs: 20_000,
        });
        expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
        client.addRequestHandler(async (request) => {
          if (request.method !== "item/tool/call") {
            return undefined;
          }
          if (!bridge) {
            throw new Error("Missing host tool bridge");
          }
          const call = readCodexDynamicToolCallParams(request.params);
          if (!call) {
            throw new Error("Invalid native dynamic tool request");
          }
          const result = await bridge.handleToolCall(call);
          results.push(result);
          return { contentItems: result.contentItems, success: result.success };
        });
        client.addNotificationHandler((notification) => {
          if (notification.method === "turn/completed") {
            completed.resolve(notification.params);
          }
        });
        mocks.consult.mockImplementation(async (params) => {
          const registration = params.onRunStarted?.({ runId, sessionId, timeoutMs: 60_000 });
          const abortSignal = registration?.abortSignal
            ? AbortSignal.any([
                registration.abortSignal,
                ...(params.abortSignal ? [params.abortSignal] : []),
              ])
            : params.abortSignal;
          try {
            await params.agentRuntime.runEmbeddedAgent({
              runId,
              sessionId,
              abortSignal,
              prompt: "Open fixture",
              workspaceDir: native.cwd,
              config: {},
              timeoutMs: 60_000,
              sessionTarget: {
                agentId: "main",
                sessionId,
                sessionKey,
                storePath: state.path("sessions.sqlite"),
              },
            });
            return { text: "done" };
          } finally {
            registration?.cleanup?.();
          }
        });
        mocks.run.mockImplementation(async (input) => {
          admission = input.preparedRunAdmission;
          if (!admission) {
            throw new Error("Talk did not prepare admission");
          }
          if (mode === "closed-before-admission") {
            await owner!.close();
          }
          const admittedRunContext = await admission.admit("plugin-harness", "codex-native-proof");
          host = createAgentHarnessHostCapabilities({
            attempt: {
              agentId: "main",
              sessionId,
              sessionKey,
              runId,
              cwd: native.cwd,
              workspaceDir: native.cwd,
              admittedRunContext,
              abortSignal: input.abortSignal,
              config: {},
            },
            pluginId: "codex",
          });
          const source = createNodesTool({
            agentId: "main",
            agentSessionKey: sessionKey,
            config: {},
          });
          const diagnostic = {
            ...source,
            execute: async (...args: Parameters<typeof source.execute>) => {
              const caller = getGatewayToolCallerIdentity();
              operands.push({
                run: Boolean(caller?.operationalRunInstance),
                inProcess: shouldUseInProcessGatewayTool({}),
                resolver: Boolean(caller?.gatewayContextResolver),
              });
              return source.execute(...args);
            },
          };
          const tool = createGatewayToolCallerWrapper("main", { agentSessionKey: sessionKey })(
            diagnostic,
          );
          bridge = createCodexDynamicToolBridge({
            tools: host.capabilities.bindToolSurface([tool]),
            signal: new AbortController().signal,
            loading: "direct",
            hookContext: { agentId: "main", sessionKey, runId },
          });
          const started = await client!.request(
            "thread/start",
            { cwd: native.cwd, dynamicTools: bridge.specs, experimentalRawEvents: true },
            { timeoutMs: 20_000 },
          );
          threadId = started.thread.id;
          // The production control owner has accepted and admitted this consult.
          // Retire/replace its presentation transport BEFORE the first native call.
          if (!owner || !createOwner) {
            throw new Error("Missing real control owner");
          }
          if (mode.startsWith("transport-replacement")) {
            replacement = createOwner();
            await replacement.adoptProvider(async () => {});
            replacement.activate();
          }
          await owner.close();
          expect(input.abortSignal?.aborted).toBe(false);
          expect(Boolean(resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey }))).toBe(
            mode.startsWith("transport-replacement"),
          );
          await expect(owner.runAgentConsult({ prompt: "late admission" })).rejects.toThrow(
            "closed",
          );
          await nativeTurn();
          expect(results[0]?.success, JSON.stringify(results[0])).toBe(true);
          expect(operands).toEqual([{ run: true, inProcess: true, resolver: true }]);
          expect(received).toEqual(["node.list", "node.invoke"]);
          if (!detachOnly) {
            if (mode === "cancelled") {
              controller.abort();
            }
            if (mode === "gateway-retired") {
              currentGateway = undefined;
            }
            if (mode === "gateway-replaced") {
              currentGateway = { ...gateway };
            }
            if (mode === "source-revoked") {
              closeAdmittedRunDelegatedAuthority(admittedRunContext);
            }
            if (mode === "execution-replaced") {
              replacementAdmission = prepareSystemAgentRunAdmission(
                {},
                runId,
                "main",
                "replacement-native-execution",
              );
              await replacementAdmission.admit("plugin-harness", "replacement-native-execution");
            }
            await nativeTurn();
          }
          return { payloads: [], meta: { durationMs: 1 } };
        });
        const runner = createTalkClientAgentConsultRunner({
          config: {},
          context,
          sessionTarget: {
            agentId: "main",
            sessionKey,
            canonicalKey: sessionKey,
            storePath: state.path("sessions.sqlite"),
          },
          ownerConnId: "native-control-connection",
          getVoiceSessionId: () => voiceSessionId,
          initialItems: [],
          registerRun: vi.fn(),
          authority: { senderIsOwner: true },
        });
        createOwner = () =>
          createTalkClientGatewayControlOwner({
            voiceSessionId,
            sessionTarget: {
              agentId: "main",
              sessionKey,
              canonicalKey: sessionKey,
              storePath: state.path("sessions.sqlite"),
            },
            connId: "native-control-connection",
            context,
            runToolAgentConsult: runner.runArgs,
            runAgentConsult: runner.runOwnedArgs,
            appendTranscript: async () => {},
            flushTranscript: async () => {},
            closeLogicalSession: () =>
              closeClientVoiceSession({ agentId: "main", sessionKey, voiceSessionId, config: {} }),
          });
        owner = createOwner();
        await owner.adoptProvider(async () => {});
        owner.activate();
        if (mode.endsWith("-owned")) {
          owner.runAgentConsult.adoptCompletionClaims?.();
        }
        const accepted = owner.runAgentConsult({
          prompt: "Open fixture",
          signal: controller.signal,
        });
        if (mode === "closed-before-admission") {
          await expect(accepted).rejects.toThrow("closed");
          expect(results).toEqual([]);
          expect(received).toEqual([]);
          return;
        }
        await accepted;
        runner.runOwnedArgs.claimFailureAppend?.();
        // Completion closes execution authority even though native declarations remain.
        if (detachOnly) {
          await nativeTurn();
        }
        expect(results[1]?.success).toBe(false);
        expect(JSON.stringify(results[1])).toMatch(/no longer active|Aborted/);
        expect(received).toEqual(["node.list", "node.invoke"]);
        currentGateway = undefined;
      } finally {
        await replacement?.close();
        await owner?.close();
        host?.close();
        admission?.close();
        replacementAdmission?.close();
        if (client) {
          expect(await client.closeAndWait()).toMatchObject({ exited: true });
        }
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });
  },
);
