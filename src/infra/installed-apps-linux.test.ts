import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareLinuxInstalledApp, scanLinuxInstalledApps } from "./installed-apps-linux.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const appId = "linux-desktop:org.example.Calculator.desktop";
let directory: string;
let entry: string;
let executable: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  directory = tempDirs.make("installed-app-launch-");
  fs.mkdirSync(path.join(directory, "applications"));
  executable = path.join(directory, "calculator");
  fs.copyFileSync(process.execPath, executable);
  fs.chmodSync(executable, 0o755);
  entry = path.join(directory, "applications", "org.example.Calculator.desktop");
  env = { XDG_DATA_HOME: directory, XDG_DATA_DIRS: directory, PATH: directory };
});
afterEach(() => vi.unstubAllEnvs());
function install(exec = executable, extra = "") {
  fs.writeFileSync(
    entry,
    ["[Desktop Entry]", "Type=Application", "Name=Calculator", "Exec=" + exec, extra, ""].join(
      "\n",
    ),
  );
}

describe.runIf(process.platform === "linux")("Linux installed app preparation", () => {
  it("lists a canonical app and binds its installed descriptor and executable revision", () => {
    install();
    const prepared = prepareLinuxInstalledApp(appId, env)!;
    expect(prepared.executable).toBe(fs.realpathSync(executable));
    expect(prepared.app).toMatchObject({
      appId,
      label: "Calculator",
      appRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(scanLinuxInstalledApps(env)).toEqual([prepared.app]);
    install("/usr/bin/true");
    expect(prepareLinuxInstalledApp(appId, env)!.app.appRevision).not.toBe(
      prepared.app.appRevision,
    );
  });
  it.each([
    "calculator --new-window",
    "sh -c calculator",
    "calculator; echo unexpected",
    "calculator %U",
    "./calculator",
  ])("does not parse a command or argument escape: %s", (exec) => {
    install(exec);
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it.each(["Terminal=true", "Hidden=true", "NoDisplay=true", "Path=/", "Exec=/bin/false"])(
    "rejects unsupported or ambiguous descriptor semantics: %s",
    (extra) => {
      install(executable, extra);
      expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    },
  );
  it.each(["Hidden = true", " Terminal = true ", "Path = /", "Exec = /usr/bin/false"])(
    "normalizes delimiter whitespace before eligibility and duplicate checks: %s",
    (extra) => {
      install(executable, extra);
      expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    },
  );
  it("accepts a quoted zero-argument executable path containing spaces", () => {
    const spaced = path.join(directory, "Example App");
    fs.mkdirSync(spaced);
    const binary = path.join(spaced, "calculator");
    fs.copyFileSync(executable, binary);
    fs.chmodSync(binary, 0o755);
    install(JSON.stringify(binary));
    expect(prepareLinuxInstalledApp(appId, env)?.executable).toBe(binary);
  });
  it("accepts a quoted bare executable without allowing another token", () => {
    install('"calculator"');
    expect(prepareLinuxInstalledApp(appId, env)?.executable).toBe(executable);
    install('"calculator" --extra');
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    install('"calculator');
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it("does not follow desktop-entry symlinks or launch scripts", () => {
    install();
    fs.renameSync(entry, entry + ".original");
    fs.symlinkSync(entry + ".original", entry);
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
    fs.unlinkSync(entry);
    install();
    fs.writeFileSync(executable, "#!/bin/sh\necho no\n");
    expect(prepareLinuxInstalledApp(appId, env)).toBeUndefined();
  });
  it("rejects traversal and never falls through a masked user desktop entry", () => {
    install();
    expect(
      prepareLinuxInstalledApp("linux-desktop:../org.example.Calculator.desktop", env),
    ).toBeUndefined();
    const system = path.join(directory, "system");
    fs.mkdirSync(path.join(system, "applications"), { recursive: true });
    fs.copyFileSync(entry, path.join(system, "applications", path.basename(entry)));
    install(executable, "Hidden=true");
    expect(prepareLinuxInstalledApp(appId, { ...env, XDG_DATA_DIRS: system })).toBeUndefined();
  });
});
