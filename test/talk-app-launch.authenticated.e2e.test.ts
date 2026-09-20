/** Real Gateway auth/RPC + built node process + zero-argument ELF window; only inference is a loopback fixture. */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import type { HelloOk } from "../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshot } from "../src/config/config.js";
import type { GatewayClient } from "../src/gateway/client.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { approveDevicePairing } from "../src/infra/device-pairing-approval.js";
import { listDevicePairing } from "../src/infra/device-pairing.js";
import { setLoggerOverride, flushLogger } from "../src/logging/logger.js";
import { resolveOpenClientVoiceSessionId } from "../src/talk/client-voice-session.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createDeferred } from "./helpers/promise.js";

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited.finally(() => clearTimeout(timer));
}
function sse(item: Record<string, unknown>) {
  return (
    [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "fixture-response",
          status: "completed",
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
    ]
      .map((event) => "data: " + JSON.stringify(event) + "\n\n")
      .join("") + "data: [DONE]\n\n"
  );
}
it.runIf(process.platform === "linux")(
  "authenticates each Talk ingress before a real node native window effect",
  { timeout: 240_000 },
  async () => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          // Preserve and restore inherited exclusions; only the owned fixture port is added below.
          NO_PROXY: process.env.NO_PROXY,
          no_proxy: process.env.no_proxy,
        },
      },
      async (state) => {
        const proofDir = path.resolve(".openclaw/tmp/app-launch-authenticated-proof");
        await fs.mkdir(proofDir, { recursive: true });
        const marker = state.path("effects.txt");
        const binary = state.path("native-window");
        const c = state.path("native-window.c");
        await fs.writeFile(
          c,
          [
            "#include <stdio.h>",
            "#include <unistd.h>",
            "typedef void Display; typedef unsigned long Window;",
            "extern Display *XOpenDisplay(char*); extern int XDefaultScreen(Display*); extern Window XRootWindow(Display*,int);",
            "extern Window XCreateSimpleWindow(Display*,Window,int,int,unsigned int,unsigned int,unsigned int,unsigned long,unsigned long);",
            "extern int XStoreName(Display*,Window,char*); extern int XMapWindow(Display*,Window); extern int XFlush(Display*);",
            "int main(void) { Display*d=XOpenDisplay(0); if(!d)return 2; Window w=XCreateSimpleWindow(d,XRootWindow(d,XDefaultScreen(d)),30,30,540,360,1,0xffffff,0x226688);",
            'XStoreName(d,w,"OpenClaw exact app launch proof"); XMapWindow(d,w); XFlush(d);',
            "FILE*f=fopen(" +
              JSON.stringify(marker) +
              ',"a"); if(!f)return 3; fprintf(f,"%d\\n",getpid()); fclose(f); sleep(30); return 0; }',
          ].join("\n"),
        );
        execFileSync("gcc", [c, "-o", binary, "-l:libX11.so.6"]);
        const desktopData = state.path("node-data");
        await fs.mkdir(path.join(desktopData, "applications"), { recursive: true });
        await fs.writeFile(
          path.join(desktopData, "applications", "proof.desktop"),
          "[Desktop Entry]\nType=Application\nName=Proof Window\nExec=" + binary + "\n",
        );
        const display = spawn(
          "Xvfb",
          ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let node: ChildProcess | undefined;
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        const clients: GatewayClient[] = [];
        let tool: Record<string, string> | undefined;
        let requests = 0;
        let phase = "prime";
        const report: Record<string, unknown> = {
          provider: "loopback deterministic OpenAI Responses fixture",
          auth: [],
          effects: [],
        };
        const revocationReady = createDeferred();
        const releaseRevocation = createDeferred();
        let heldRevocationResponse = false;
        const providerRequests: Array<{ phase: string; path?: string }> = [];
        const providerServer = createServer((req, res) => {
          providerRequests.push({ phase, path: req.url });
          req.resume();
          req.on("end", () => {
            const item =
              phase !== "prime" && requests++ === 0 && tool
                ? {
                    type: "function_call",
                    id: "fc_" + phase,
                    call_id: "call_" + phase,
                    name: "nodes",
                    arguments: JSON.stringify(tool),
                    status: "completed",
                  }
                : {
                    type: "message",
                    id: "msg_" + phase,
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "Fixture completed " + phase, annotations: [] },
                    ],
                  };
            const send = () => {
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(sse(item));
            };
            if (phase === "device-revoked" && !heldRevocationResponse) {
              heldRevocationResponse = true;
              revocationReady.resolve();
              void releaseRevocation.promise.then(send);
            } else {
              send();
            }
          });
        });
        const launchedPids = async () =>
          (await fs.readFile(marker, "utf8").catch(() => ""))
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map(Number);
        let nodeLogs = "";
        setLoggerOverride({ level: "debug", file: state.path("gateway-proof.log") });
        try {
          const [displayChunk] = await once(display.stdout!, "data");
          const displayName = ":" + String(displayChunk).trim();
          await new Promise<void>((resolve) => {
            providerServer.listen(0, "127.0.0.1", resolve);
          });
          const address = providerServer.address();
          if (!address || typeof address === "string") {
            throw new Error("No provider listener");
          }
          const localFixture = "127.0.0.1:" + address.port;
          for (const key of ["NO_PROXY", "no_proxy"]) {
            process.env[key] = [process.env[key], localFixture].filter(Boolean).join(",");
          }
          const provider = buildMockOpenAiResponsesProvider(
            "http://127.0.0.1:" + address.port + "/v1",
          );
          const cfg = {
            talk: { realtime: { provider: "openai", mode: "realtime", appLaunchPolicies: [] } },
            logging: { level: "debug", file: state.path("gateway-proof.log") },
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                skipBootstrap: true,
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
              entries: { main: { default: true } },
            },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            gateway: {
              mode: "local",
              auth: { mode: "token", token: "synthetic-app-proof-token" },
              nodes: {
                commands: {
                  allow: [
                    "device.apps",
                    "device.apps.launch",
                    "system.execApprovals.get",
                    "system.execApprovals.set",
                  ],
                },
                pairing: { autoApproveLocal: false, sshVerify: false },
              },
            },
          };
          report.stage = "bootstrap-admin";
          const start = () =>
            startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              token: "synthetic-app-proof-token",
              scopes: ["operator.admin"],
              clientDisplayName: "app-proof-admin",
            });
          await expect(start()).rejects.toThrow("pairing required");
          // Bootstrap the owned isolated installation by approving its actual persisted request.
          // All voice-device and node approvals below cross the authenticated operator RPC.
          const bootstrap = (await listDevicePairing(state.stateDir)).pending.find(
            (entry) => entry.displayName === "app-proof-admin" && entry.role === "operator",
          );
          if (!bootstrap) {
            throw new Error("Missing isolated operator bootstrap request");
          }
          expect(
            await approveDevicePairing(
              bootstrap.requestId,
              { callerScopes: ["operator.admin"] },
              state.stateDir,
            ),
          ).toMatchObject({ status: "approved" });
          gateway = await start();
          const admin = gateway.client;
          const loadedAtStartup = await readConfigFileSnapshot();
          expect(loadedAtStartup.valid).toBe(true);
          expect(loadedAtStartup.config.talk?.realtime).toMatchObject({
            provider: "openai",
            mode: "realtime",
            appLaunchPolicies: [],
          });
          const url = "ws://127.0.0.1:" + gateway.port;
          const identity = loadOrCreateDeviceIdentity({ path: state.path("voice-device.sqlite") });
          let hello: HelloOk | undefined;
          report.stage = "pair-voice-device";
          await expect(
            connectGatewayClient({
              url,
              token: "synthetic-app-proof-token",
              deviceIdentity: identity,
              scopes: ["operator.admin"],
            }),
          ).rejects.toThrow("pairing required");
          const pending = await admin.request<{
            pending: Array<{ requestId: string; deviceId: string }>;
          }>("device.pair.list", {});
          const pairing = pending.pending.find((entry) => entry.deviceId === identity.deviceId);
          if (!pairing) {
            throw new Error("Missing real voice-device pairing request");
          }
          await admin.request("device.pair.approve", { requestId: pairing.requestId });
          report.stage = "signed-shared-token";
          const shared = await connectGatewayClient({
            url,
            token: "synthetic-app-proof-token",
            deviceIdentity: identity,
            scopes: ["operator.admin"],
            onHelloOk: (value) => {
              hello = value;
            },
          });
          clients.push(shared);
          expect(hello?.auth.method).toBe("token");
          const deviceToken = hello?.auth.deviceToken;
          if (!deviceToken) {
            throw new Error("Signed client did not receive paired device token");
          }
          report.stage = "paired-device-token";
          const paired = await connectGatewayClient({
            url,
            deviceToken,
            deviceIdentity: identity,
            scopes: ["operator.admin"],
            onHelloOk: (value) => {
              hello = value;
            },
          });
          clients.push(paired);
          expect(hello?.auth.method).toBe("device-token");
          report.auth = [
            "signed-device + shared token: token",
            "signed-device + issued device token: device-token",
          ];
          const otherIdentity = loadOrCreateDeviceIdentity({
            path: state.path("other-voice-device.sqlite"),
          });
          await expect(
            connectGatewayClient({
              url,
              token: "synthetic-app-proof-token",
              deviceIdentity: otherIdentity,
              scopes: ["operator.admin"],
            }),
          ).rejects.toThrow("pairing required");
          const otherPending = await admin.request<{
            pending: Array<{ requestId: string; deviceId: string }>;
          }>("device.pair.list", {});
          const otherPairing = otherPending.pending.find(
            (entry) => entry.deviceId === otherIdentity.deviceId,
          );
          if (!otherPairing) {
            throw new Error("Missing other-device pairing request");
          }
          await admin.request("device.pair.approve", { requestId: otherPairing.requestId });
          const otherShared = await connectGatewayClient({
            url,
            token: "synthetic-app-proof-token",
            deviceIdentity: otherIdentity,
            scopes: ["operator.admin"],
            onHelloOk: (value) => {
              hello = value;
            },
          });
          clients.push(otherShared);
          const otherToken = hello?.auth.deviceToken;
          if (!otherToken) {
            throw new Error("Missing other-device token");
          }
          const other = await connectGatewayClient({
            url,
            deviceToken: otherToken,
            deviceIdentity: otherIdentity,
            scopes: ["operator.admin"],
            onHelloOk: (value) => {
              hello = value;
            },
          });
          clients.push(other);
          expect(hello?.auth.method).toBe("device-token");
          expect(otherIdentity.deviceId).not.toBe(identity.deviceId);
          (report.auth as string[]).push("different signed device + issued token: device-token");
          const nodeRoot = state.path("node");
          await fs.mkdir(nodeRoot, { recursive: true });
          const nodeConfig = path.join(nodeRoot, "openclaw.json");
          await fs.writeFile(
            nodeConfig,
            JSON.stringify({
              gateway: { mode: "local" },
              plugins: { enabled: false },
              nodeHost: { browserProxy: { enabled: false }, skills: { enabled: false } },
            }),
          );
          const startNode = () => {
            const child = spawn(
              process.execPath,
              [
                "dist/index.js",
                "node",
                "run",
                "--host",
                "127.0.0.1",
                "--port",
                String(gateway.port),
                "--display-name",
                "Isolated app proof node",
                "--share-installed-apps",
              ],
              {
                cwd: process.cwd(),
                stdio: ["ignore", "pipe", "pipe"],
                env: {
                  PATH: process.env.PATH,
                  HOME: nodeRoot,
                  OPENCLAW_HOME: nodeRoot,
                  OPENCLAW_STATE_DIR: path.join(nodeRoot, "state"),
                  OPENCLAW_CONFIG_PATH: nodeConfig,
                  OPENCLAW_GATEWAY_TOKEN: "synthetic-app-proof-token",
                  XDG_DATA_HOME: desktopData,
                  XDG_DATA_DIRS: desktopData,
                  DISPLAY: displayName,
                  OPENCLAW_SKIP_CHANNELS: "1",
                  OPENCLAW_SKIP_PROVIDERS: "1",
                },
              },
            );
            child.stdout?.on("data", (chunk) => {
              nodeLogs += String(chunk);
            });
            child.stderr?.on("data", (chunk) => {
              nodeLogs += String(chunk);
            });
            return child;
          };
          node = startNode();
          report.stage = "pair-node";
          let nodeId = "";
          await expect
            .poll(
              async () => {
                for (const kind of ["device", "node"]) {
                  const list = await admin.request<{
                    pending?: Array<{ requestId: string; role?: string }>;
                  }>(kind + ".pair.list", {});
                  for (const entry of list.pending ?? []) {
                    if (kind === "node" || entry.role === "node") {
                      await admin.request(kind + ".pair.approve", { requestId: entry.requestId });
                      // The real node intentionally pauses after a pairing refusal.
                      await stop(node);
                      node = startNode();
                    }
                  }
                }
                const nodes = await admin.request<{
                  nodes: Array<{ nodeId: string; connected?: boolean; commands?: string[] }>;
                }>("node.list", {});
                const selected = nodes.nodes.find(
                  (entry) => entry.connected && entry.commands?.includes("device.apps.launch"),
                );
                nodeId = selected?.nodeId ?? "";
                return Boolean(nodeId);
              },
              { timeout: 45_000, interval: 500 },
            )
            .toBe(true);
          const inventory = await admin.request<{
            payload: { apps: Array<{ appId: string; appRevision: string }> };
          }>("node.invoke", {
            nodeId,
            command: "device.apps",
            params: {},
            idempotencyKey: "inventory",
          });
          const installed = inventory.payload.apps.find(
            (entry) => entry.appId === "linux-desktop:proof.desktop",
          );
          if (!installed) {
            throw new Error("Node did not inventory native fixture");
          }
          const app = { appId: installed.appId, appRevision: installed.appRevision };
          report.nodePaired = true;
          report.stage = "configure-exact-policy";
          tool = { action: "app_launch", node: nodeId, ...app };
          const approvals = await admin.request<{ hash: string }>("exec.approvals.node.get", {
            nodeId,
          });
          await admin.request("exec.approvals.node.set", {
            nodeId,
            baseHash: approvals.hash,
            file: {
              version: 1,
              agents: {
                main: { security: "allowlist", ask: "off", allowlist: [{ pattern: binary }] },
              },
            },
          });
          const snapshot = await admin.request<{ hash: string }>("config.get", {});
          await admin.request("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify({
              talk: {
                realtime: {
                  appLaunchPolicies: [
                    {
                      id: "proof",
                      agentId: "main",
                      originatingDeviceId: identity.deviceId,
                      nodeId,
                      ...app,
                      expiresAtMs: Date.now() + 120_000,
                    },
                  ],
                },
              },
            }),
          });
          const loadedAfterPatch = await readConfigFileSnapshot();
          expect(loadedAfterPatch.valid).toBe(true);
          expect(loadedAfterPatch.config.talk?.realtime).toMatchObject({
            provider: "openai",
            mode: "realtime",
            appLaunchPolicies: [
              {
                id: "proof",
                agentId: "main",
                originatingDeviceId: identity.deviceId,
                nodeId,
                ...app,
              },
            ],
          });
          report.configLoading = {
            provider: "openai",
            mode: "realtime",
            startupPolicyCount: 0,
            postPatchPolicyCount: loadedAfterPatch.config.talk?.realtime?.appLaunchPolicies?.length,
          };
          const sessionKey = "agent:main:app-proof";
          const invoke = async (
            client: GatewayClient,
            name: string,
            voiceSessionId?: string,
            beforeInference?: () => Promise<void>,
            observer = client,
          ) => {
            phase = name;
            report.stage = name;
            requests = 0;
            const started = await client.request<{ runId: string }>("talk.client.toolCall", {
              sessionKey,
              voiceSessionId,
              callId: "call-" + name,
              name: "openclaw_agent_consult",
              args: { question: name === "prime" ? "Read status" : "Open Proof Window" },
            });
            await beforeInference?.();
            const done = await observer.request<{ status: string }>(
              "agent.wait",
              { runId: started.runId, timeoutMs: 45_000 },
              { timeoutMs: 50_000 },
            );
            report.lastRun = { phase: name, runId: started.runId, result: done };
            if (done.status !== "ok") {
              report.history = await observer.request("chat.history", { sessionKey, limit: 8 });
            }
            expect(done.status).toBe("ok");
          };
          await invoke(paired, "prime");
          const voiceSessionId = resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey });
          if (!voiceSessionId) {
            throw new Error("Real RPC did not create voice record");
          }
          await paired.request("talk.client.transcript", {
            sessionKey,
            voiceSessionId,
            entryId: "utterance",
            role: "user",
            text: "Open Proof Window",
          });
          await invoke(shared, "shared-denied", voiceSessionId);
          expect(await launchedPids()).toHaveLength(0);
          await invoke(other, "wrong-device-denied", voiceSessionId);
          expect(await launchedPids()).toHaveLength(0);
          await invoke(paired, "paired-launch", voiceSessionId);
          await expect.poll(async () => (await launchedPids()).length, { timeout: 10_000 }).toBe(1);
          execFileSync(
            "ffmpeg",
            [
              "-y",
              "-f",
              "x11grab",
              "-video_size",
              "640x480",
              "-i",
              displayName,
              "-frames:v",
              "1",
              path.join(proofDir, "launched.png"),
            ],
            { stdio: "pipe" },
          );
          await invoke(paired, "paired-repeat", voiceSessionId);
          await expect.poll(async () => (await launchedPids()).length, { timeout: 10_000 }).toBe(2);
          const current = await admin.request<{ hash: string }>("config.get", {});
          await admin.request("config.patch", {
            baseHash: current.hash,
            replacePaths: ["talk.realtime.appLaunchPolicies"],
            raw: JSON.stringify({ talk: { realtime: { appLaunchPolicies: [] } } }),
          });
          await invoke(paired, "revoked-denied", voiceSessionId);
          expect(await launchedPids()).toHaveLength(2);
          const restored = await admin.request<{ hash: string }>("config.get", {});
          await admin.request("config.patch", {
            baseHash: restored.hash,
            raw: JSON.stringify({
              talk: {
                realtime: {
                  appLaunchPolicies: [
                    {
                      id: "proof",
                      agentId: "main",
                      originatingDeviceId: identity.deviceId,
                      nodeId,
                      ...app,
                      expiresAtMs: Date.now() + 120_000,
                    },
                  ],
                },
              },
            }),
          });
          await invoke(
            paired,
            "device-revoked",
            voiceSessionId,
            async () => {
              await revocationReady.promise;
              expect(await launchedPids()).toHaveLength(2);
              const revoked = await admin.request<{
                deviceId: string;
                role: string;
                revokedAtMs: number;
              }>("device.token.revoke", { deviceId: identity.deviceId, role: "operator" });
              expect(revoked).toMatchObject({ deviceId: identity.deviceId, role: "operator" });
              expect(revoked.revokedAtMs).toBeGreaterThan(0);
              report.deviceRevocation = {
                method: "device.token.revoke",
                role: "operator",
                beforeToolResponseAndPermit: true,
                policyRestored: true,
                revokedAtMs: revoked.revokedAtMs,
              };
              releaseRevocation.resolve();
            },
            admin,
          );
          expect(await launchedPids()).toHaveLength(2);
          report.effects = [
            "shared-token: 0",
            "wrong-device-token: 0",
            "device-token: 1",
            "repeat: 2",
            "policy-revoked: 2",
            "device-token-revoked-before-permit: 2",
          ];
          report.status = "passed";
        } catch (error) {
          report.status = "failed";
          report.error = String(error);
          report.nodeLogs = nodeLogs.slice(-8000);
          report.providerRequests = providerRequests;
          await fs
            .copyFile(
              state.path("gateway-proof.log"),
              path.join(proofDir, "gateway-last-failure.log"),
            )
            .catch(() => {});
          throw error;
        } finally {
          releaseRevocation.resolve();
          for (const pid of await launchedPids()) {
            try {
              if ((await fs.realpath("/proc/" + pid + "/exe")) === binary) {
                process.kill(pid, "SIGTERM");
              }
            } catch {}
          }
          await stop(node);
          await stop(display);
          for (const client of clients) {
            await disconnectGatewayClient(client);
          }
          if (gateway) {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close();
          }
          await new Promise<void>((resolve) => {
            providerServer.close(() => resolve());
          });
          await flushLogger();
          setLoggerOverride(null);
          await fs.writeFile(path.join(proofDir, "receipt.json"), JSON.stringify(report, null, 2));
        }
      },
    );
  },
);
