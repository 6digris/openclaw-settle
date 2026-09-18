import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker, withTestSpawnBroker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBrowserExecutableForPlatform } from "./chrome.executables.js";
import { resolveBrowserConfig } from "./config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("browser executable discovery spawn ownership", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves the Linux default browser with all fallback probes parented by the broker", async () => {
    const directory = await fs.realpath(tempDirs.make("openclaw-browser-probes-broker-"));
    const binDirectory = path.join(directory, "bin");
    const applicationsDirectory = path.join(directory, ".local", "share", "applications");
    const receiptPath = path.join(directory, "parents.jsonl");
    const browserPath = path.join(binDirectory, "google-chrome");
    await fs.mkdir(binDirectory);
    await fs.mkdir(applicationsDirectory, { recursive: true });
    await fs.writeFile(browserPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fs.writeFile(
      path.join(applicationsDirectory, "google-chrome.desktop"),
      "[Desktop Entry]\nExec=google-chrome %U\n",
    );
    for (const [command, output, exitCode] of [
      ["xdg-settings", "", 1],
      ["xdg-mime", "google-chrome.desktop\n", 0],
      ["which", `${browserPath}\n`, 0],
    ] as const) {
      await fs.writeFile(
        path.join(binDirectory, command),
        `#!${process.execPath}\n` +
          `const fs = require("node:fs");\n` +
          `fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({\n` +
          `  command: ${JSON.stringify(command)}, args: process.argv.slice(2), ppid: process.ppid,\n` +
          `}) + "\\n");\n` +
          `process.stdout.write(${JSON.stringify(output)});\n` +
          `process.exitCode = ${exitCode};\n`,
        { mode: 0o700 },
      );
    }
    // Vitest's environment overlay does not change the native home-directory lookup.
    vi.spyOn(os, "homedir").mockReturnValue(directory);
    vi.stubEnv("HOME", directory);
    vi.stubEnv("PATH", `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`);

    await withTestSpawnBroker(async ({ pid }) => {
      const executable = await resolveBrowserExecutableForPlatform(
        resolveBrowserConfig(undefined),
        "linux",
      );

      expect(executable).toEqual({ kind: "chrome", path: browserPath });
      const receipts = (await fs.readFile(receiptPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(receipts).toEqual([
        { command: "xdg-settings", args: ["get", "default-web-browser"], ppid: pid },
        {
          command: "xdg-mime",
          args: ["query", "default", "x-scheme-handler/http"],
          ppid: pid,
        },
        { command: "which", args: ["google-chrome"], ppid: pid },
      ]);
      expect(receipts.map((receipt) => receipt.ppid)).not.toContain(process.pid);
    });
  });
});
