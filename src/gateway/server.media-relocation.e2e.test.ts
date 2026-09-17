import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { makeAssistantMessageFixture } from "../agents/test-helpers/assistant-message-fixtures.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { ensureStagedInputDirectory } from "../media/staged-inputs.js";
import { withSessionTranscriptWriteLock } from "../plugin-sdk/session-transcript-runtime.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  setupGatewayTempHome,
  removeGatewayTempHome,
  resetGatewayTestState,
} from "./gateway.test-support.js";
import { createGatewaySession } from "./session-create-service.js";
import { startGatewayWithClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const providerRequest = z.object({
  input: z.array(
    z.object({
      content: z
        .array(
          z.object({
            type: z.string(),
            image_url: z.string().optional(),
            text: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  tools: z.array(z.unknown()).optional(),
});

it(
  "replays relocated staged images through the registered agent request",
  { timeout: 90_000 },
  async () => {
    resetGatewayTestState();
    const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
      prefix: "openclaw-media-relocation-",
    });
    const provider = {
      ...buildMockOpenAiResponsesProvider("https://media-fixture.invalid/v1", "fixture-vision"),
      providerId: "openai",
      modelRef: "openai/fixture-vision",
    };
    provider.config.models[0].input = ["text", "image"];
    deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
    deleteTestEnvValue("OPENCLAW_SKIP_PROVIDERS");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(process.cwd(), "extensions"));
    const requests: Array<{ body: string; parsed: z.infer<typeof providerRequest> }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://media-fixture.invalid/")) {
        throw new Error("Unexpected fetch destination in the media replay test");
      }
      const body =
        init?.body !== undefined
          ? String(init.body)
          : input instanceof Request
            ? await input.clone().text()
            : "";
      requests.push({ body, parsed: providerRequest.parse(JSON.parse(body)) });
      const events = [
        {
          type: "response.output_item.added",
          item: {
            type: "message",
            id: "fixture-message",
            role: "assistant",
            content: [],
            status: "in_progress",
          },
        },
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            id: "fixture-message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "fixture complete", annotations: [] }],
          },
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    let running: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const token = "synthetic-media-relocation-token";
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: provider.modelRef },
            models: {
              [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
            },
          },
          entries: { main: { default: true } },
        },
        models: { mode: "replace" as const, providers: { [provider.providerId]: provider.config } },
        gateway: { auth: { token } },
        plugins: { allow: ["openai"] },
      };
      running = await startGatewayWithClient({
        cfg,
        configPath: await createGatewayConfigPath(tempHome),
        token,
        clientDisplayName: "media-relocation-test",
      });
      await running.server.startupSettled;
      const catalog = await running.client.request<{
        models: Array<{ id: string; provider: string; input?: string[] }>;
      }>("models.list", { view: "provider-config" });
      const selectedModel = catalog.models.find(
        (model) => model.id === provider.modelId && model.provider === provider.providerId,
      );
      expect(selectedModel?.input).toContain("image");
      const directory = "media/inbound/openclaw-staged-11111111-1111-4111-8111-111111111111";
      const relative = `${directory}/input-historical.png`;
      await ensureStagedInputDirectory(workspaceDir, directory);
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
        "base64",
      );
      await fs.writeFile(path.join(workspaceDir, relative), image);
      const currentPath = path.join(workspaceDir, directory, "input-current.gif");
      const currentImage = Buffer.from([
        71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0,
        0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
      ]);
      await fs.writeFile(currentPath, currentImage);
      const oldWorkspace = path.join(tempHome, "former-host", "workspace");
      const created = await createGatewaySession({
        cfg,
        key: "agent:main:relocated-media",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        atomicInitialization: true,
        afterCreate: async (entry) => {
          await withSessionTranscriptWriteLock(
            {
              agentId: entry.agentId,
              sessionId: entry.entry.sessionId,
              sessionKey: entry.key,
              storePath: entry.storePath,
            },
            async (transcript) => {
              const turns = [
                {
                  text: "Historical synthetic image",
                  path: path.join(oldWorkspace, relative),
                  workspaceDir: oldWorkspace,
                  contentType: "image/png",
                },
                {
                  text: "Current synthetic image",
                  path: currentPath,
                  workspaceDir,
                  contentType: "image/gif",
                },
              ];
              for (const [index, turn] of turns.entries()) {
                await transcript.appendMessage({
                  message: {
                    role: "user",
                    content: turn.text,
                    timestamp: index * 2 + 1,
                    __openclaw: {
                      media: [
                        {
                          path: turn.path,
                          url: turn.path,
                          workspaceDir: turn.workspaceDir,
                          contentType: turn.contentType,
                          kind: "image",
                        },
                      ],
                    },
                  },
                });
                // Completed turns exercise history replay rather than orphaned-input repair.
                await transcript.appendMessage({
                  message: makeAssistantMessageFixture({
                    content: [{ type: "text", text: "Image received." }],
                    stopReason: "stop",
                    errorMessage: undefined,
                    provider: provider.providerId,
                    model: provider.modelId,
                    timestamp: index * 2 + 2,
                  }),
                });
              }
            },
          );
        },
      });
      if (!created.ok) {
        throw new Error(created.error.message);
      }
      const scope = {
        agentId: created.agentId,
        sessionId: created.entry.sessionId,
        sessionKey: created.key,
        storePath: created.storePath,
      };
      const before = await loadTranscriptEvents(scope);
      const accepted = await running.client.request<{ status: string }>(
        "agent",
        {
          sessionKey: created.key,
          idempotencyKey: "synthetic-relocation-replay",
          message: "Continue this conversation.",
          deliver: false,
        },
        { expectFinal: false },
      );
      expect(accepted.status).toBe("accepted");
      // Auxiliary title requests include history text but do not have the agent's tools.
      const findAgentRequest = () =>
        requests.find(
          (request) =>
            request.body.includes("Continue this conversation.") &&
            (request.parsed.tools?.length ?? 0) > 0,
        );
      await expect.poll(findAgentRequest, { timeout: 45_000, interval: 100 }).toBeDefined();
      const request = findAgentRequest();
      if (!request) {
        throw new Error("Agent provider request was not captured");
      }
      expect(request.body).toContain("Historical synthetic image");
      expect(request.body).toContain("Current synthetic image");
      const images = request.parsed.input.flatMap(
        (entry) =>
          entry.content
            ?.filter((block) => block.type === "input_image")
            .map((block) => block.image_url) ?? [],
      );
      expect(images).toEqual([
        `data:image/png;base64,${image.toString("base64")}`,
        `data:image/gif;base64,${currentImage.toString("base64")}`,
      ]);
      const after = await loadTranscriptEvents(scope);
      expect(after.slice(0, before.length)).toEqual(before);
    } finally {
      try {
        if (running) {
          try {
            await disconnectGatewayClient(running.client);
          } finally {
            await running.server.close({ reason: "media relocation test complete" });
          }
        }
      } finally {
        fetchMock.mockRestore();
        try {
          await removeGatewayTempHome(tempHome);
        } finally {
          envSnapshot.restore();
          resetGatewayTestState();
        }
      }
    }
  },
);
