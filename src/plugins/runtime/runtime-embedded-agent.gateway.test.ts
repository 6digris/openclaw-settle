import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { shouldUseInProcessGatewayTool } from "../../agents/tools/gateway.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginScope,
} from "./gateway-request-scope.js";
import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

type CoreRun = typeof import("../../agents/embedded-agent.js").runEmbeddedAgent;
const mocks = vi.hoisted(() => ({ run: vi.fn<CoreRun>() }));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.run }));
afterEach(() => vi.clearAllMocks());

it.each([
  "hosted",
  "standalone",
  "retire",
  "replace",
  "retire-before-admit",
  "replace-before-admit",
] as const)(
  "preserves exact scoped plugin admission without ambient promotion: %s",
  async (mode) => {
    const gateway = {} as GatewayRequestContext;
    const rival = {} as GatewayRequestContext;
    let current: GatewayRequestContext | undefined = gateway;
    const resolver = () => current;
    let host: ReturnType<typeof createAgentHarnessHostCapabilities> | undefined;
    let execute: (() => Promise<unknown>) | undefined;
    const params = {
      config: {},
      prompt: "check",
      runId: "plugin-scoped-proof",
      sessionId: "plugin-scoped-session",
      agentId: "main",
      sessionKey: "agent:main:plugin-scoped-proof",
      timeoutMs: 1000,
      workspaceDir: process.cwd(),
    };
    mocks.run.mockImplementation(async (input) => {
      if (!input.preparedRunAdmission) {
        throw new Error("Missing plugin admission");
      }
      if (mode === "retire-before-admit") {
        current = undefined;
      }
      if (mode === "replace-before-admit") {
        current = rival;
      }
      const admittedRunContext = await input.preparedRunAdmission.admit(
        "plugin-harness",
        "native-fixture",
      );
      const admittedResolver = getGatewayContextResolver(admittedRunContext);
      if (mode !== "standalone") {
        expect(admittedResolver?.()).toBe(gateway);
        expect(admittedResolver && getCanonicalGatewayContextResolver(admittedResolver)).toBe(
          resolver,
        );
      }
      host = createAgentHarnessHostCapabilities({
        attempt: { ...params, admittedRunContext },
        pluginId: "fixture",
      });
      const [tool] = host.capabilities.bindToolSurface([
        {
          name: "read",
          label: "Read",
          description: "Read owned routing",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [],
            details: {
              gateway: getGatewayToolCallerIdentity()?.gatewayContextResolver?.(),
              inProcess: shouldUseInProcessGatewayTool({}),
            },
          }),
        },
      ]);
      if (!tool) {
        throw new Error("Missing bound tool");
      }
      execute = () => tool.execute("plugin-call", {});
      await withPluginRuntimeGatewayRequestScope(
        { isWebchatConnect: () => false, resolveGatewayContext: () => rival },
        async () => {
          // A competing scope must neither redirect hosted tools nor promote a standalone run.
          expect(await execute!()).toMatchObject({
            details: {
              gateway: mode === "standalone" ? undefined : gateway,
              inProcess: mode !== "standalone",
            },
          });
          if (mode === "retire" || mode === "replace") {
            current = mode === "retire" ? undefined : rival;
            await expect(execute!()).rejects.toThrow("no longer active");
          }
        },
      );
      return { payloads: [], meta: { durationMs: 1 } };
    });
    try {
      const run = withPluginRuntimeGatewayRequestScope(
        {
          isWebchatConnect: () => false,
          ...(mode === "standalone" ? {} : { resolveGatewayContext: resolver }),
        },
        () =>
          withPluginRuntimePluginScope({ pluginId: "fixture" }, () =>
            runPluginEmbeddedAgent(params),
          ),
      );
      if (mode === "retire-before-admit" || mode === "replace-before-admit") {
        await expect(run).rejects.toThrow("Gateway owner is no longer active");
      } else {
        await run;
        expect(execute).toBeDefined();
        await expect(execute!()).rejects.toThrow("no longer active");
      }
    } finally {
      host?.close();
    }
  },
);
