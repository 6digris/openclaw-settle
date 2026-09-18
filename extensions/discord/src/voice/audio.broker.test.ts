import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { useAutoCleanupTempDirTracker, withTestSpawnBroker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeSpawn, executable } = vi.hoisted(() => ({
  nativeSpawn: vi.fn(),
  executable: { path: "" },
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  nativeSpawn.mockImplementation(actual.spawn);
  return { ...actual, spawn: nativeSpawn };
});
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  resolveFfmpegBin: () => executable.path,
}));

import { createDiscordOpusPlaybackStream, decodeOpusStreamChunks } from "./audio.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("Discord playback spawn ownership", () => {
  it.each(["file", "stream"] as const)(
    "streams %s audio through ffmpeg owned by the broker instead of the Gateway",
    async (inputKind) => {
      const directory = tempDirs.make("openclaw-discord-audio-broker-");
      const receiptPath = path.join(directory, "spawn.json");
      executable.path = path.join(directory, "ffmpeg.cjs");
      await fs.writeFile(
        executable.path,
        `#!${process.execPath}\n` +
          `const fs = require('node:fs');\n` +
          `const chunks = [];\n` +
          `process.stdin.on('data', chunk => chunks.push(chunk));\n` +
          `process.stdin.on('end', () => {\n` +
          `  fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({\n` +
          `    ppid: process.ppid, argv: process.argv.slice(2),\n` +
          `    input: Buffer.concat(chunks).toString('hex'),\n` +
          `  }));\n` +
          `  process.stdout.end(Buffer.alloc(960 * 2 * 2));\n` +
          `});\n`,
        { mode: 0o700 },
      );
      const inputBytes = Buffer.from("synthetic audio input");
      await withTestSpawnBroker(async ({ pid }) => {
        nativeSpawn.mockClear();
        const playback = createDiscordOpusPlaybackStream(
          inputKind === "stream" ? Readable.from([inputBytes]) : "input.mp3",
        );
        const packets: Buffer[] = [];
        try {
          for await (const packet of playback) {
            packets.push(Buffer.from(packet as Buffer));
          }
        } finally {
          playback.destroy();
        }
        expect(packets).toHaveLength(1);
        const onChunk = vi.fn();
        await decodeOpusStreamChunks(Readable.from(packets), {
          onChunk,
          onVerbose: vi.fn(),
          onWarn: vi.fn(),
        });
        expect(onChunk.mock.calls[0]?.[0]).toHaveLength(960 * 2 * 2);
        const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
        expect(receipt).toEqual({
          ppid: pid,
          argv: [
            "-i",
            inputKind === "stream" ? "pipe:0" : "input.mp3",
            "-analyzeduration",
            "0",
            "-loglevel",
            "error",
            "-vn",
            "-sn",
            "-dn",
            "-f",
            "s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "pipe:1",
          ],
          input: inputKind === "stream" ? inputBytes.toString("hex") : "",
        });
        expect(nativeSpawn).not.toHaveBeenCalled();
      });
    },
  );
});
