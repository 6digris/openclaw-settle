import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(() => Promise.resolve(actual), { spawn: vi.fn(actual.spawn) });
});

const nativeSpawn = vi.mocked(spawn);

function createTransport(
  commands: Pick<
    Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0],
    "inputCommand" | "outputCommand" | "bargeInInputCommand"
  >,
) {
  return createLocalMeetingRealtimeAudioTransport({
    ...commands,
    bargeInCooldownMs: 0,
    bargeInPeakThreshold: 0,
    bargeInRmsThreshold: 0,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logScope: "[meeting]",
  });
}

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "local meeting audio broker transport",
  () => {
    let broker: SpawnBrokerHost;

    beforeEach(async () => {
      broker = createSpawnBrokerHost();
      await broker.ready();
      nativeSpawn.mockClear();
    });

    afterEach(async () => {
      await broker.close();
      vi.restoreAllMocks();
    });

    it("captures, plays, monitors, and replaces audio through broker-owned processes", async () => {
      const dir = tempDirs.make("openclaw-meeting-audio-broker-");
      const recordsPath = path.join(dir, "processes.jsonl");
      const outputPath = path.join(dir, "output.pcm");
      await fs.writeFile(recordsPath, "");
      await fs.writeFile(outputPath, "");
      const command = (role: string) => [
        process.execPath,
        "-e",
        String.raw`
          const fs = require('node:fs');
          const [role, records, output] = process.argv.slice(1);
          fs.appendFileSync(records, JSON.stringify({role, pid: process.pid, ppid: process.ppid}) + '\n');
          if (role === 'output') {
            process.stdin.on('data', chunk => fs.appendFileSync(output, chunk));
          } else {
            process.stdout.write(Buffer.from([1, 2, 3, 4]));
          }
          setInterval(() => {}, 1000);
        `,
        role,
        recordsPath,
        outputPath,
      ];
      const records = async (): Promise<Array<{ role: string; pid: number; ppid: number }>> =>
        (await fs.readFile(recordsPath, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      const transport = runWithSpawnBroker(broker, () =>
        createTransport({
          inputCommand: command("input"),
          outputCommand: command("output"),
          bargeInInputCommand: command("barge-in"),
        }),
      );
      const onAudio = vi.fn();
      const onBargeIn = vi.fn(() => true);
      transport.startInput(onAudio);
      runWithSpawnBroker(broker, () => transport.startBargeInMonitor?.(onBargeIn));
      try {
        await transport.writeOutput(Buffer.from([5, 6]));
        await expect.poll(async () => (await fs.readFile(outputPath)).toString("hex")).toBe("0506");
        await expect.poll(() => onAudio.mock.calls).toEqual([[Buffer.from([1, 2, 3, 4])]]);
        await expect.poll(() => onBargeIn.mock.calls).toEqual([[Buffer.from([1, 2, 3, 4])]]);

        await runWithSpawnBroker(broker, () => transport.clearOutput());
        await transport.writeOutput(Buffer.from([7, 8]));
        await expect
          .poll(async () => (await fs.readFile(outputPath)).toString("hex"))
          .toBe("05060708");
        await expect.poll(async () => (await records()).length).toBe(4);
        const children = await records();
        expect(children.map(({ role }) => role).sort()).toEqual([
          "barge-in",
          "input",
          "output",
          "output",
        ]);
        expect(children.map(({ ppid }) => ppid)).toEqual(Array(4).fill(broker.pid));
        expect(nativeSpawn).not.toHaveBeenCalled();
        await transport.stop();
        expect(children.every(({ pid }) => isPidDefinitelyDead(pid))).toBe(true);
      } finally {
        await transport.stop();
      }
    });

    it.each(["stop", "clear"] as const)(
      "releases pending audio writes on %s before broker admission completes",
      async (action) => {
        const outputPath = path.join(
          tempDirs.make("openclaw-meeting-audio-pending-"),
          "output.pcm",
        );
        await fs.writeFile(outputPath, "");
        const brokerSpawn = vi.spyOn(broker, "spawn");
        process.kill(broker.pid!, "SIGSTOP");
        const command = [
          process.execPath,
          "-e",
          "process.stdin.on('data', chunk => require('node:fs').appendFileSync(process.argv[1], chunk)); setInterval(() => {}, 1000)",
          outputPath,
        ];
        const transport = runWithSpawnBroker(broker, () =>
          createTransport({ inputCommand: command, outputCommand: command }),
        );
        try {
          const writing = transport.writeOutput(Buffer.from([1, 2]));
          const finishing =
            action === "stop"
              ? transport.stop()
              : runWithSpawnBroker(broker, () => transport.clearOutput());
          await withTestTimeout(
            writing,
            1_000,
            `${action} did not release the pending audio write`,
          );
          expect(brokerSpawn).toHaveBeenCalledTimes(action === "stop" ? 2 : 3);
          expect(nativeSpawn).not.toHaveBeenCalled();
          process.kill(broker.pid!, "SIGCONT");
          await finishing;
          if (action === "clear") {
            await transport.writeOutput(Buffer.from([3, 4]));
            await expect
              .poll(async () => (await fs.readFile(outputPath)).toString("hex"))
              .toBe("0304");
          }
          await transport.stop();
          for (const result of brokerSpawn.mock.results) {
            if (result.type !== "return") {
              throw new Error("Expected a broker child");
            }
            await withTestTimeout(
              result.value.waitForClose(),
              5_000,
              "late audio child did not stop",
            );
            expect(isPidDefinitelyDead(result.value.pid!)).toBe(true);
          }
        } finally {
          process.kill(broker.pid!, "SIGCONT");
          await transport.stop();
        }
      },
    );
  },
);
