import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "openclaw/plugin-sdk/process-runtime";
import { useIsolatedStateGuard, withTestSpawnBroker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";

const nativeSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  nativeSpawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: nativeSpawn };
});

import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import { httpRequest } from "./sandbox-exec-server/http.js";
import { startProcess, writeProcess } from "./sandbox-exec-server/processes.js";
import type { ManagedProcess, OpenClawExecServer } from "./sandbox-exec-server/types.js";

useIsolatedStateGuard();

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "Codex sandbox spawn ownership",
  () => {
    it("bounds shutdown during admission and reaps the late child and its descendants", async () => {
      await withTestSpawnBroker(async ({ pid: brokerPid }) => {
        const receiptPath = path.join(process.env.OPENCLAW_TEST_HOME!, `${randomUUID()}.json`);
        let receipt: { pid: number; descendant: number } | undefined;
        const finalizeExec = vi.fn(async () => undefined);
        const sandbox = createSandboxContext({
          buildExecSpec: async () => ({
            argv: [
              process.execPath,
              "-e",
              `const { spawn } = require('node:child_process');
             const fs = require('node:fs');
             process.on('SIGTERM', () => {});
             const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
             fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ pid: process.pid, descendant: descendant.pid }));
             setInterval(() => {}, 1000);`,
            ],
            env: {},
            finalizeToken: "late-start-token",
            stdinMode: "pipe-open",
          }),
          runShellCommand: async () => {
            // Hold remote cleanup until the admitted helper has created its tree.
            receipt = await vi.waitFor(
              async () => JSON.parse(await readFile(receiptPath, "utf8")),
              {
                timeout: 5_000,
              },
            );
            return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
          },
          finalizeExec,
        });
        const server = {
          sandbox,
          backend: sandbox.backend,
          fsBridge: sandbox.fsBridge,
          children: new Set(),
          cleanupTasks: new Set(),
        } as OpenClawExecServer;
        const processes = new Map<string, ManagedProcess>();
        process.kill(brokerPid, "SIGSTOP");
        const start = startProcess(server, processes, vi.fn(), {
          processId: "late-start",
          argv: ["fixture"],
          cwd: "file:///workspace",
          env: {},
          tty: false,
          pipeStdin: true,
        });
        void start.catch(() => undefined);
        try {
          await vi.waitFor(() => expect(server.children.size).toBe(1));
          const owner = [...server.children][0]!;
          const stoppedAt = performance.now();
          await expect(owner.terminate()).rejects.toThrow("survived SIGKILL");
          expect(performance.now() - stoppedAt).toBeLessThan(6_500);
          expect(server.children.size).toBe(1);
          expect(finalizeExec).not.toHaveBeenCalled();
          process.kill(brokerPid, "SIGCONT");
          await expect(start).rejects.toThrow("survived SIGKILL");
          await owner.settled;
          expect(receipt).toBeDefined();
          await vi.waitFor(() => {
            expect(isPidAlive(receipt!.pid)).toBe(false);
            expect(isPidAlive(receipt!.descendant)).toBe(false);
          });
          expect(server.children.size).toBe(0);
          expect(processes.size).toBe(0);
          expect(finalizeExec).toHaveBeenCalledExactlyOnceWith({
            status: "failed",
            exitCode: null,
            timedOut: false,
            token: "late-start-token",
          });
        } finally {
          process.kill(brokerPid, "SIGCONT");
          if (receipt && isPidAlive(receipt.pid)) {
            process.kill(-receipt.pid, "SIGKILL");
          }
          await start.catch(() => undefined);
          await Promise.all(
            [...server.children].map((owner) => owner.settled.catch(() => undefined)),
          );
        }
      });
    }, 15_000);

    it.each(["process", "streaming HTTP"] as const)(
      "runs %s helpers in the broker and retains their output and finalization",
      async (kind) => {
        const finalizeExec = vi.fn(async () => undefined);
        const sandbox = createSandboxContext({
          buildExecSpec: async () => ({
            argv: [
              process.execPath,
              "-e",
              `process.stdin.once('data', (input) => {
                const receipt = { ppid: process.ppid, env: process.env.PROBE, input: input.toString() };
                if (${JSON.stringify(kind)} === 'process') {
                  process.stdout.write(JSON.stringify(receipt));
                  process.stderr.write('helper stderr');
                } else {
                  process.stdout.write(JSON.stringify({ type: 'headers', status: 200, headers: [] }) + '\\n');
                  process.stdout.write(JSON.stringify({ type: 'bodyDelta', seq: 1, deltaBase64: Buffer.from(JSON.stringify(receipt)).toString('base64'), done: true }) + '\\n');
                }
                process.exit(0);
              });`,
            ],
            env: { PROBE: "sandbox-env" },
            finalizeToken: "broker-owned-token",
            stdinMode: "pipe-open",
          }),
          finalizeExec,
        });
        const server = {
          sandbox,
          backend: sandbox.backend,
          fsBridge: sandbox.fsBridge,
          children: new Set(),
          cleanupTasks: new Set(),
        } as OpenClawExecServer;
        const processes = new Map<string, ManagedProcess>();
        const notify = vi.fn();
        await withTestSpawnBroker(async ({ pid }) => {
          nativeSpawn.mockClear();
          try {
            if (kind === "process") {
              await startProcess(server, processes, notify, {
                processId: "broker-process",
                argv: ["echo", "sandbox request"],
                cwd: "file:///workspace",
                env: {},
                tty: false,
                pipeStdin: true,
              });
              expect(
                writeProcess(processes, {
                  processId: "broker-process",
                  chunk: Buffer.from("process input").toString("base64"),
                }),
              ).toEqual({ status: "accepted" });
            } else {
              await expect(
                httpRequest(
                  server,
                  { send: notify, isOpen: () => true, signal: new AbortController().signal },
                  {
                    requestId: "broker-http",
                    method: "GET",
                    url: "https://example.test/stream",
                    streamResponse: true,
                  },
                ),
              ).resolves.toEqual({ status: 200, headers: [], bodyBase64: "" });
            }
            await vi.waitFor(() => expect(finalizeExec).toHaveBeenCalledOnce());
            const payload = notify.mock.calls.find(([method, value]) =>
              kind === "process"
                ? method === "process/output" && value.stream === "stdout"
                : method === "http/request/bodyDelta",
            )?.[1];
            expect(payload).toBeDefined();
            const receipt = JSON.parse(
              Buffer.from(
                kind === "process" ? payload.chunk : payload.deltaBase64,
                "base64",
              ).toString(),
            );
            expect(receipt.ppid).toBe(pid);
            expect(receipt.env).toBe("sandbox-env");
            if (kind === "process") {
              expect(receipt.input).toBe("process input");
              expect(processes.get("broker-process")).toMatchObject({
                closed: true,
                exited: true,
                exitCode: 0,
              });
              expect(notify).toHaveBeenCalledWith("process/output", {
                processId: "broker-process",
                seq: expect.any(Number),
                stream: "stderr",
                chunk: Buffer.from("helper stderr").toString("base64"),
              });
            } else {
              expect(JSON.parse(receipt.input)).toMatchObject({
                method: "GET",
                url: "https://example.test/stream",
                streamResponse: true,
              });
            }
            expect(finalizeExec).toHaveBeenCalledWith({
              status: "completed",
              exitCode: 0,
              timedOut: false,
              token: "broker-owned-token",
            });
            expect(server.children.size).toBe(0);
            expect(nativeSpawn).not.toHaveBeenCalled();
          } finally {
            await Promise.all([...server.children].map((child) => child.terminate()));
            for (const child of processes.values()) {
              clearTimeout(child.evictionTimer);
            }
          }
        });
      },
    );
  },
);
