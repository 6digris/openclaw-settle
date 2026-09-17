// Exercise document RPCs through the registered workspace service and node wire.
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import fileTransferPlugin from "../../../../extensions/file-transfer/index.js";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { GatewayClient } from "../../../../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const COMMANDS = ["file.fetch", "file.stat", "file.write"];

describe("node workspace document access", () => {
  it(
    "preserves reader access and live edits without using the Gateway copy",
    { timeout: 180_000 },
    async () => {
      const state = await createOpenClawTestState({
        label: "workspace-node-files",
        layout: "home",
        applyEnv: false,
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_FAST: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        },
      });
      const remote = path.join(await fs.realpath(state.root), "harness");
      await fs.mkdir(remote);
      await fs.mkdir(state.workspaceDir, { recursive: true });
      const document = path.join(remote, "AGENTS.md");
      const localDocument = path.join(state.workspaceDir, "AGENTS.md");
      await fs.writeFile(document, "Harness instructions");
      await fs.writeFile(localDocument, "Stale Gateway copy");
      const nodeIdentity = loadOrCreateDeviceIdentity({ path: state.path("node.sqlite") });
      const nodeId = nodeIdentity.deviceId;
      const config: OpenClawConfig = {
        gateway: {
          mode: "local",
          bind: "loopback",
          controlUi: { enabled: false },
          nodes: { commands: { allow: COMMANDS } },
        },
        agents: {
          list: [{ id: "qa", default: true, workspace: state.workspaceDir }],
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
          },
        },
        plugins: {
          allow: ["file-transfer"],
          slots: { memory: "none" },
          entries: {
            "file-transfer": {
              enabled: true,
              config: {
                policyVersion: 2,
                workspaces: { qa: { nodeId, remoteRoot: remote } },
                nodes: {
                  [nodeId]: {
                    ask: "off",
                    allowReadPaths: [document],
                    allowWritePaths: [document],
                    followSymlinks: false,
                  },
                },
              },
            },
          },
        },
      };
      const gatewayOwner = createQaGatewayChild();
      let owner: GatewayClient | undefined;
      let reader: GatewayClient | undefined;
      let node: GatewayClient | undefined;
      const invocations: string[] = [];
      const responses: Promise<void>[] = [];
      const errors: unknown[] = [];
      try {
        // Run the built host and built plugin together. Mixing a source Gateway
        // with a packaged plugin creates two separate workspace registries.
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("openclaw.mjs")],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1:1",
          enabledPluginIds: ["file-transfer"],
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            gateway: { ...cfg.gateway, nodes: config.gateway!.nodes },
            agents: config.agents,
            plugins: config.plugins,
          }),
        });
        const connection = { url: gateway.wsUrl, token: gateway.token, timeoutMs: 60_000 };
        owner = await connectGatewayClient({
          ...connection,
          scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
          deviceIdentity: loadOrCreateDeviceIdentity({ path: state.path("owner.sqlite") }),
        });
        reader = await connectGatewayClient({
          ...connection,
          scopes: ["operator.read"],
          deviceIdentity: loadOrCreateDeviceIdentity({ path: state.path("reader.sqlite") }),
        });
        node = await connectGatewayClient({
          ...connection,
          clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
          mode: GATEWAY_CLIENT_MODES.NODE,
          role: "node",
          scopes: [],
          caps: ["file"],
          commands: COMMANDS,
          deviceIdentity: nodeIdentity,
          onEvent(event) {
            if (event.event !== "node.invoke.request") {
              return;
            }
            const frame = event.payload as {
              id: string;
              nodeId: string;
              command: string;
              paramsJSON: string | null;
            };
            const response = (async () => {
              const handler = fileTransferPlugin.nodeHostCommands?.find(
                (entry) => entry.command === frame.command,
              );
              if (!handler || !node) {
                throw new Error(`Unexpected command ${frame.command}`);
              }
              invocations.push(frame.command);
              const payloadJSON = await handler.handle(frame.paramsJSON);
              await node.request("node.invoke.result", {
                id: frame.id,
                nodeId: frame.nodeId,
                ok: true,
                payloadJSON,
              });
            })().catch((error: unknown) => {
              errors.push(error);
            });
            responses.push(response);
          },
        });
        await vi.waitFor(
          async () => {
            const result = await owner!.request<{
              pending?: Array<{ nodeId: string; requestId: string }>;
            }>("node.pair.list", {});
            const pending = result.pending?.find((entry) => entry.nodeId === nodeId);
            expect(pending).toBeDefined();
            await owner!.request("node.pair.approve", { requestId: pending!.requestId });
          },
          { timeout: 15_000 },
        );
        await vi.waitFor(
          async () => {
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              true,
            );
          },
          { timeout: 15_000 },
        );

        const get = () =>
          reader!.request<{ file: { content: string; hash: string } }>("agents.files.get", {
            agentId: "qa",
            name: "AGENTS.md",
          });
        const opened = await get();
        expect(opened.file.content).toBe("Harness instructions");
        expect(invocations).toContain("file.stat");
        expect(invocations).toContain("file.fetch");
        await expect(
          reader.request("agents.files.set", {
            agentId: "qa",
            name: "AGENTS.md",
            content: "denied",
          }),
        ).rejects.toThrow(/scope|permission/i);
        await expect(
          reader.request("node.invoke", {
            nodeId,
            command: "file.fetch",
            params: { path: document },
            idempotencyKey: "reader-direct-fetch",
          }),
        ).rejects.toThrow(/scope|permission/i);
        await owner.request("agents.files.set", {
          agentId: "qa",
          name: "AGENTS.md",
          content: "Owner edit",
          expectedHash: opened.file.hash,
        });
        expect(await fs.readFile(document, "utf8")).toBe("Owner edit");
        await fs.writeFile(document, "Harness edit");
        expect((await get()).file.content).toBe("Harness edit");
        expect(await fs.readFile(localDocument, "utf8")).toBe("Stale Gateway copy");

        await disconnectGatewayClient(node);
        node = undefined;
        await vi.waitFor(
          async () => {
            const result = await owner!.request<{
              nodes?: Array<{ nodeId: string; connected?: boolean }>;
            }>("node.list", {});
            expect(result.nodes?.some((entry) => entry.nodeId === nodeId && entry.connected)).toBe(
              false,
            );
          },
          { timeout: 15_000 },
        );
        await expect(get()).rejects.toThrow(/node|connected|unavailable/i);
        expect(await fs.readFile(localDocument, "utf8")).toBe("Stale Gateway copy");
        await Promise.all(responses);
        expect(errors).toEqual([]);
      } finally {
        await Promise.all(responses);
        for (const client of [node, reader, owner]) {
          if (client) {
            await disconnectGatewayClient(client);
          }
        }
        try {
          await stopQaGatewayFixture(gatewayOwner);
        } finally {
          await state.cleanup();
        }
      }
    },
  );
});
