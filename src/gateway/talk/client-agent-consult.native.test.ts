/** Real native app-server requests cross the production dynamic-tool and host boundaries.
 * Inference/model selection and the node transport are fixtures; Gateway dispatch, policy record and native ELF effect are real.
 */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_VERSION,
  createCodexDynamicToolBridge,
  createNativeToolControllerFixture,
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
import {
  onTrustedToolExecutionEvent,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { consultRealtimeVoiceAgent } from "../../talk/agent-consult-runtime.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  resolveOpenClientVoiceSessionId,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import { createNativeAppPolicyFixture } from "./native-app-policy.test-support.js";

type Consult = typeof consultRealtimeVoiceAgent;
type CoreRun = typeof import("../../agents/embedded-agent.js").runEmbeddedAgent;
const mocks = vi.hoisted(() => ({
  run: vi.fn<CoreRun>(),
  consult: vi.fn<Consult>(),
}));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.run }));
vi.mock("../../talk/agent-consult-runtime.js", () => ({
  consultRealtimeVoiceAgent: mocks.consult,
}));

afterEach(() => {
  vi.clearAllMocks();
  setDiagnosticsEnabledForProcess(false);
  vi.unstubAllEnvs();
  clientVoiceSessionTesting.reset();
  resetClientVoiceConfirmationStateForTest();
});

it
  .runIf(process.platform === "linux")
  .each([
    "active",
    "diagnostics-enabled",
    "unapproved",
    "node-denied",
    "policy-revoked-before-ready",
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
      setDiagnosticsEnabledForProcess(mode === "diagnostics-enabled");
      const denial =
        mode === "unapproved" || mode === "node-denied" || mode === "policy-revoked-before-ready";
      let voiceSessionId = "";
      const fixture = await createNativeAppPolicyFixture(state, denial ? mode : "launch", () => {
        const effect = clientVoiceSessionTesting
          .readRecord("main", voiceSessionId)
          ?.effects.find((entry) => entry.toolCallId === "launch-3");
        expect(effect).toMatchObject({
          runId: "native-launch-repro",
          toolCallId: "launch-3",
          voicePolicyId: "calculator",
          status: "started",
        });
      });
      const native = await createCodexNativeTestState(state.path("native"));
      const runId = "native-launch-repro";
      const controller = new AbortController();
      const detachOnly =
        mode.startsWith("logical-close") ||
        mode.startsWith("transport-replacement") ||
        mode === "active" ||
        mode === "diagnostics-enabled";
      let owner: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      let createOwner: (() => ReturnType<typeof createTalkClientGatewayControlOwner>) | undefined;
      const sessionKey = "agent:main:native-launch-proof";
      const sessionId = "native-launch-proof";
      voiceSessionId = createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        transcriptCapable: true,
      });
      const gateway = fixture.context;
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
      const executionEvents: Array<{
        type: string;
        toolCallId?: string;
        mutatingAction?: boolean;
      }> = [];
      const unsubscribe = onTrustedToolExecutionEvent((event) => {
        if (event.runId === runId) {
          executionEvents.push(event);
        }
      });
      let requests = 0;
      let modelNamespace: string | undefined;
      let requestController: ReturnType<typeof createNativeToolControllerFixture> | undefined;
      let lastNativeTerminal: unknown;

      const nativeRequests: string[] = [];
      const server = http.createServer((request, response) => {
        request.resume();
        request.on("end", () => {
          const step = requests++ % 4;
          const action = step === 0 ? "status" : step === 1 ? "app_list" : "app_launch";
          const item =
            step < 3
              ? {
                  type: "function_call",
                  call_id: (step === 2 ? "launch-" : "read-") + requests,
                  name: "nodes",
                  ...(modelNamespace ? { namespace: modelNamespace } : {}),
                  arguments: JSON.stringify({
                    action,
                    node: "paired-node",
                    ...(step === 2
                      ? { appId: fixture.app.appId, appRevision: fixture.app.appRevision }
                      : {}),
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
      const results: Array<{ success: boolean; contentItems: unknown[] }> = [];
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
          config: fixture.config(),
          timeoutMs: 20_000,
        });
        expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
        client.addRequestHandler(async (request) => {
          nativeRequests.push(request.method);
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
          if (!requestController) {
            throw new Error("Missing production request controller");
          }
          const rawResult = await requestController.handleServerRequest(request, {
            threadId: call.threadId,
            turnId: call.turnId,
          });
          const result: unknown = rawResult;
          if (
            !result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            !("success" in result) ||
            typeof result.success !== "boolean" ||
            !("contentItems" in result) ||
            !Array.isArray(result.contentItems)
          ) {
            throw new Error("Native controller returned no response");
          }
          if (call.callId === "read-1" || call.callId === "read-2") {
            expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual(
              [],
            );
          }
          if (result.success && call.callId === "launch-3") {
            expect(
              await requestController.handleServerRequest(request, {
                threadId: call.threadId,
                turnId: call.turnId,
              }),
            ).toEqual(result);
          }
          results.push({ success: result.success, contentItems: result.contentItems });
          return rawResult;
        });
        client.addNotificationHandler((notification) => {
          if (notification.method === "turn/started" && requestController) {
            const value = notification.params as { turn?: { id?: string } };
            requestController.turnIdRef.current = value.turn?.id;
          }
          if (notification.method === "turn/completed") {
            lastNativeTerminal = notification.params;
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
              config: fixture.config(),
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
              config: fixture.config(),
            },
            pluginId: "codex",
          });
          const source = createNodesTool({
            agentId: "main",
            agentSessionKey: sessionKey,
            config: fixture.config(),
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
          modelNamespace = bridge.specs.find(
            (spec) =>
              spec.type === "namespace" &&
              spec.tools.some((descriptor) => descriptor.name === "nodes"),
          )?.name;
          const started = await client!.request(
            "thread/start",
            { cwd: native.cwd, dynamicTools: bridge.specs, experimentalRawEvents: true },
            { timeoutMs: 20_000 },
          );
          threadId = started.thread.id;
          requestController = createNativeToolControllerFixture({
            bridge,
            client: client!,
            threadId,
            runId,
            sessionId,
            sessionKey,
            signal: new AbortController().signal,
          });
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
          if (!denial && mode !== "active" && mode !== "diagnostics-enabled") {
            await owner.close();
          }
          expect(input.abortSignal?.aborted).toBe(false);
          expect(Boolean(resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey }))).toBe(
            mode.startsWith("transport-replacement") ||
              denial ||
              mode === "active" ||
              mode === "diagnostics-enabled",
          );
          if (owner.signal.aborted) {
            await expect(owner.runAgentConsult({ prompt: "late admission" })).rejects.toThrow(
              "closed",
            );
          }
          await nativeTurn();
          expect(results.slice(0, 2).map((result) => result.success)).toEqual([true, true]);
          expect(JSON.stringify(results[1])).toContain(fixture.app.appId);
          expect(JSON.stringify(results[1])).toContain(fixture.app.appRevision);
          if (denial) {
            expect(results[2]?.success, JSON.stringify(results[2])).toBe(false);
            expect(JSON.stringify(results[2])).toMatch(
              /VOICE_CONFIRMATION_REQUIRED|not advertise|not allow|denied/,
            );
            expect(fixture.effectCount()).toBe(0);
            expect(
              fixture.permits.some(
                (permit) => (permit as { type: string }).type === "installed-app-launch.allow",
              ),
            ).toBe(false);
            if (mode === "unapproved") {
              expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual(
                [],
              );
            }
            return { payloads: [], meta: { durationMs: 1 } };
          }
          expect(
            results[2]?.success,
            JSON.stringify({
              result: results[2],
              requests,
              lastNativeTerminal,
              executionEvents,
              nativeRequests,
            }),
          ).toBe(true);
          expect(operands).toEqual(
            Array.from({ length: 3 }, () => ({ run: true, inProcess: true, resolver: true })),
          );
          await expect.poll(() => fixture.effectCount()).toBe(1);
          const effect = clientVoiceSessionTesting
            .readRecord("main", voiceSessionId)
            ?.effects.find((entry) => entry.toolCallId === "launch-3");
          expect(effect).toMatchObject({ runId, toolName: "nodes", voicePolicyId: "calculator" });
          expect(
            executionEvents.filter(
              (event) => event.type === "tool.execution.started" && event.mutatingAction === true,
            ),
          ).toHaveLength(1);
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
          getOriginAuthority: () => fixture.origin,
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
          expect(fixture.effectCount()).toBe(0);
          return;
        }
        await accepted;
        runner.runOwnedArgs.claimFailureAppend?.();
        if (denial) {
          return;
        }
        // Completion closes execution authority even though native declarations remain.
        if (detachOnly) {
          await nativeTurn();
        }
        expect(results.slice(3).map((result) => result.success)).toEqual([false, false, false]);
        expect(JSON.stringify(results.slice(3))).toMatch(/no longer active|Aborted/);
        expect(fixture.effectCount()).toBe(1);
        currentGateway = undefined;
      } finally {
        unsubscribe();
        await replacement?.close();
        await owner?.close();
        host?.close();
        admission?.close();
        replacementAdmission?.close();
        if (client) {
          expect(await client.closeAndWait()).toMatchObject({ exited: true });
        }
        await fixture.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });
  },
);
