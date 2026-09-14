import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// QA Lab Slack tests cover module-specific flow preparation boundaries.
import { describe, expect, it, vi } from "vitest";
import { buildQaGatewayConfig } from "../../qa-gateway-config.js";
import { applyQaMergePatch } from "../../suite-merge-patch.js";
import { createSlackQaScenarioEnvironment } from "./scenario-environment.js";
import { runSlackScenario } from "./scenario-runtime.js";
import type { SlackQaConfigOverrides } from "./slack-live.contracts.js";
import { runSlackDeliveryProof } from "./slack-live.delivery-proof.js";
import { slackQaAllowlistBlockScenario } from "./slack-live.scenario-implementations.js";

vi.mock("./scenario-runtime.js", () => ({ runSlackScenario: vi.fn() }));
vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  createDebugProxyCaptureReader: () => ({ getSessionEvents: () => [] }),
}));

function createEnvironment() {
  return createSlackQaScenarioEnvironment({
    accountId: "work",
    channelId: "C123456789",
    driverBotUserId: "U123456789",
    driverClient: {} as never,
    getMessageWriteCursor: () => 0,
    readMessageWrites: async () => [],
    sutAppToken: "xapp-test",
    sutBotToken: "xoxb-test",
    sutIdentity: { userId: "U987654321" },
    sutReadClient: {} as never,
    sutWriteClient: {} as never,
  });
}

async function prepareSeededEnvironment() {
  const seed = buildQaGatewayConfig({
    bind: "loopback",
    gatewayPort: 18789,
    gatewayToken: "test-token",
    workspaceDir: "/tmp/qa-workspace",
    providerMode: "live-frontier",
    primaryModel: "anthropic/claude-opus-4-8",
    alternateModel: "anthropic/claude-opus-4-8",
  });
  const sibling = { identity: { name: "Sibling" }, model: "anthropic/claude-opus-4-8" };
  let config: OpenClawConfig = {
    ...seed,
    agents: { ...seed.agents, entries: { ...seed.agents?.entries, sibling } },
  };
  const gatewayCall = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config,
        hash: "config-hash",
        configRevisionHash: "revision",
        appliedConfigHash: "revision",
      };
    }
    if (method === "config.patch") {
      // SAFETY: This fixture receives the production patch serializer's config payload.
      const patch = params as { raw: string };
      // SAFETY: Exercise the same object omission/null semantics as the Gateway config owner.
      config = applyQaMergePatch(config, JSON.parse(patch.raw)) as OpenClawConfig;
      return { hash: "config-hash" };
    }
    if (method === "channels.status") {
      return {
        channelAccounts: {
          slack: [
            {
              accountId: "work",
              connected: true,
              lastConnectedAt: Date.now() - 30_000,
              restartPending: false,
              running: true,
            },
          ],
        },
      };
    }
    if (method === "logs.tail") {
      return { file: "gateway.log", cursor: 0, lines: [], reset: false, truncated: false };
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
  const prepared = await createEnvironment().prepareFlow({
    config: {},
    gateway: {
      call: gatewayCall,
      runtimeEnv: { OPENCLAW_DEBUG_PROXY_SESSION_ID: "test-session" },
    } as never,
    outputDir: "/tmp/slack-output",
    primaryModel: "anthropic/claude-opus-4-8",
    scenarioId: "slack-delivery",
    scenarioTitle: "Slack delivery",
    timeoutMs: 1000,
    waitForConfigRestartSettle: vi.fn(),
  });
  return {
    environment: prepared.slackScenarioContext,
    gatewayCall,
    seed,
    sibling,
    readConfig: () => config,
  };
}

describe("Slack scenario environment", () => {
  it.each(["final-only", "progress", "message-tool"] as const)(
    "applies %s configuration before its real pre-send guard",
    async (mode) => {
      const { environment, gatewayCall, seed, sibling, readConfig } =
        await prepareSeededEnvironment();
      await runSlackDeliveryProof(environment, mode);
      const implementation = vi.mocked(runSlackScenario).mock.lastCall?.[1];
      if (!implementation) {
        throw new Error("delivery implementation missing");
      }
      const { cfg, run } = await environment.configureScenario(implementation);
      expect(seed.agents?.entries?.qa?.identity).toBeDefined();
      expect(cfg.agents?.entries?.qa?.identity).toBeUndefined();
      const applied = await gatewayCall("config.get");
      expect(applied).toMatchObject({
        config: {
          agents: {
            entries: {
              qa: {
                model: seed.agents?.entries?.qa?.model,
                tools: seed.agents?.entries?.qa?.tools,
              },
              sibling,
            },
          },
        },
      });
      expect(readConfig().agents?.entries?.qa?.identity).toBeUndefined();
      if (run.kind && run.kind !== "message") {
        throw new Error("expected message scenario");
      }
      await expect(run.beforeRun?.(environment.context)).resolves.toBeUndefined();
      expect(gatewayCall).toHaveBeenCalledWith("logs.tail", expect.any(Object));
      // A drifted runtime must report only failed contract names, never config values.
      const qa = readConfig().agents?.entries?.qa;
      if (!qa) {
        throw new Error("QA agent missing");
      }
      qa.identity = { name: "private-fixture-name" };
      await expect(run.beforeRun?.(environment.context)).rejects.toEqual(
        new Error(
          "Slack delivery proof runtime configuration differs from the selected mode; failed checks: qaIdentityAbsent",
        ),
      );
    },
  );

  it.each([
    { name: "progress", overrides: { progress: { toolProgress: true } }, removes: true },
    { name: "ordinary", overrides: {}, removes: false },
  ] satisfies Array<{ name: string; overrides: SlackQaConfigOverrides; removes: boolean }>)(
    "preserves the %s scenario's identity intent across config.patch",
    async ({ overrides, removes }) => {
      const { environment, readConfig, seed, sibling } = await prepareSeededEnvironment();
      await environment.configureScenario({
        configOverrides: overrides,
        buildRun: () => ({ expectReply: false, input: "test", matchText: "test" }),
      });
      expect(readConfig().agents?.entries?.qa?.identity).toEqual(
        removes ? undefined : seed.agents?.entries?.qa?.identity,
      );
      expect(readConfig().agents?.entries?.sibling).toEqual(sibling);
    },
  );

  it("leaves generic declarative flows on the adapter's baseline config", async () => {
    const gatewayCall = vi.fn();
    const { prepareFlow } = createEnvironment();

    const prepared = await prepareFlow({
      config: { replyMarker: "QA-THREAD-FOLLOW-UP-OK" },
      gateway: { call: gatewayCall } as never,
      outputDir: "/tmp/slack-output",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarioId: "thread-follow-up",
      scenarioTitle: "Thread follow-up",
      timeoutMs: 60_000,
      waitForConfigRestartSettle: vi.fn(),
    });
    expect(prepared.slackScenarioContext.scenario).toEqual({
      id: "thread-follow-up",
      timeoutMs: 60_000,
      title: "Thread follow-up",
    });
    expect(gatewayCall).not.toHaveBeenCalled();
  });

  it("authorizes the exact Slack account and channel array replacement paths", async () => {
    const gatewayCall = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config.get") {
        return { config: {}, hash: "config-hash" };
      }
      if (method === "config.patch") {
        return { noop: true };
      }
      if (method === "channels.status") {
        return {
          channelAccounts: {
            slack: [
              {
                accountId: "work",
                connected: true,
                lastConnectedAt: Date.now() - 30_000,
                restartPending: false,
                running: true,
              },
            ],
          },
        };
      }
      throw new Error(`unexpected gateway method: ${method}`);
    });
    const { prepareFlow } = createEnvironment();
    const prepared = await prepareFlow({
      config: {},
      gateway: { call: gatewayCall } as never,
      outputDir: "/tmp/slack-output",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarioId: "slack-allowlist-block",
      scenarioTitle: "Slack allowlist block",
      timeoutMs: 60_000,
      waitForConfigRestartSettle: vi.fn(),
    });

    await prepared.slackScenarioContext.configureScenario(slackQaAllowlistBlockScenario);

    const patchCall = gatewayCall.mock.calls.find(([method]) => method === "config.patch");
    if (!patchCall) {
      throw new Error("config.patch was not called");
    }
    expect(patchCall[1]).toMatchObject({
      replacePaths: expect.arrayContaining([
        "channels.slack.accounts.work.allowFrom",
        "channels.slack.accounts.work.channels.C123456789.users",
      ]),
    });
  });
});
