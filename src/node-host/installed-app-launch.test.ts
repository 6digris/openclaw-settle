import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareLinuxInstalledApp } from "../infra/installed-apps-linux.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.node-host.js";
import { prepareInstalledAppLaunch } from "./installed-app-launch.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const appId = "linux-desktop:fixture.desktop";
let entry: string;
let executable: string;
beforeEach(() => {
  const root = tempDirs.make("node-installed-launch-");
  fs.mkdirSync(path.join(root, "applications"));
  executable = path.join(root, "fixture-native");
  fs.copyFileSync(process.execPath, executable);
  fs.chmodSync(executable, 0o755);
  entry = path.join(root, "applications", "fixture.desktop");
  fs.writeFileSync(
    entry,
    ["[Desktop Entry]", "Type=Application", "Name=Fixture", "Exec=" + executable, ""].join("\n"),
  );
  vi.stubEnv("XDG_DATA_HOME", root);
  vi.stubEnv("XDG_DATA_DIRS", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function harness() {
  const controller = new AbortController();
  let input: ((raw: string) => void) | undefined;
  const emitChunk = vi.fn(async () => {});
  const io: OpenClawPluginNodeHostCommandIo = {
    signal: controller.signal,
    emitChunk,
    onInput: (callback) => {
      input = callback;
    },
  };
  const app = prepareLinuxInstalledApp(appId)!.app;
  const prepared = prepareInstalledAppLaunch({
    platform: "linux",
    sharingEnabled: true,
    paramsJSON: JSON.stringify({ appId, appRevision: app.appRevision, agentId: "main" }),
    io,
  });
  return {
    prepared,
    emitChunk,
    controller,
    reply: (value: unknown) => input!(JSON.stringify(value)),
  };
}

describe.runIf(process.platform === "linux")("installed-app final launch boundary", () => {
  it("waits for invocation authorization and rechecks local permission before a real native spawn", async () => {
    const h = harness();
    const assertCurrent = vi.fn();
    const launched = h.prepared.run(
      [executable],
      undefined,
      {},
      undefined,
      h.controller.signal,
      assertCurrent,
    );
    expect(h.emitChunk).toHaveBeenCalledWith(expect.stringContaining("installed-app-launch.ready"));
    expect(assertCurrent).not.toHaveBeenCalled();
    h.reply({ type: "installed-app-launch.allow", validForMs: 5000 });
    await expect(launched).resolves.toMatchObject({ success: true });
    expect(assertCurrent).toHaveBeenCalledOnce();
  });
  it("rejects descriptor substitution while waiting for authorization", async () => {
    const h = harness();
    const launched = h.prepared.run(
      [executable],
      undefined,
      {},
      undefined,
      h.controller.signal,
      () => {},
    );
    fs.appendFileSync(entry, "Exec=/usr/bin/true\n");
    h.reply({ type: "installed-app-launch.allow", validForMs: 5000 });
    await expect(launched).rejects.toThrow("descriptor changed");
  });
  it("keeps an independent local permission denial authoritative", async () => {
    const h = harness();
    const launched = h.prepared.run(
      [executable],
      undefined,
      {},
      undefined,
      h.controller.signal,
      () => {
        throw new Error("local policy denied");
      },
    );
    h.reply({ type: "installed-app-launch.allow", validForMs: 5000 });
    await expect(launched).rejects.toThrow("local policy denied");
  });
  it.each(["deny", "abort"])("does not launch after %s during the final wait", async (mode) => {
    const h = harness();
    const launched = h.prepared.run(
      [executable],
      undefined,
      {},
      undefined,
      h.controller.signal,
      () => {},
    );
    if (mode === "abort") {
      h.controller.abort();
    } else {
      h.reply({ type: "installed-app-launch.deny" });
    }
    await expect(launched).rejects.toThrow();
  });
  it("rejects expiry after the permit round trip without relying on clock synchronization", async () => {
    const h = harness();
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const launched = h.prepared.run(
      [executable],
      undefined,
      {},
      undefined,
      h.controller.signal,
      () => {},
    );
    now.mockReturnValue(200);
    h.reply({ type: "installed-app-launch.allow", validForMs: 50 });
    await expect(launched).rejects.toThrow("expired");
  });
});
