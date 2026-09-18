import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { findGatewayServices, renderGatewayServiceCleanupHints } from "./inspect.js";
import { readStartupEntryCommand, resolveStartupEntryPath } from "./schtasks-layout.js";
import * as taskProbe from "./schtasks-state-probe.js";

const nativePlatform = process.platform;
let root: string;

beforeEach(async () => {
  // A UNC spelling also resolves to a real fixture directory on POSIX hosts.
  root = await fs.mkdtemp(
    nativePlatform === "win32"
      ? path.join(os.tmpdir(), "openclaw-startup-")
      : "\\\\openclaw-startup-",
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function environment() {
  return { APPDATA: path.join(root, "appdata"), OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" };
}

async function startup(form: "cmd" | "9.2/9.3" | "9.4", taskName = "OpenClaw Gateway (rescue)") {
  const env = { ...environment(), OPENCLAW_WINDOWS_TASK_NAME: taskName };
  const scriptPath = path.join(root, "rescue", "gateway.cmd");
  const startupPath = resolveStartupEntryPath(env, form === "cmd" ? "cmd" : "vbs");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(startupPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      'set "OPENCLAW_SERVICE_MARKER=openclaw"',
      'set "OPENCLAW_SERVICE_KIND=gateway"',
      `set "OPENCLAW_WINDOWS_TASK_NAME=${taskName}"`,
      'set "OPENCLAW_PROFILE=rescue"',
      `set "OPENCLAW_STATE_DIR=${path.dirname(scriptPath)}"`,
      '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789 < NUL',
      "",
    ].join("\r\n"),
  );
  const content =
    form === "cmd"
      ? `@echo off\r\nstart "" /min cmd.exe /d /c "${scriptPath}"\r\n`
      : form === "9.4"
        ? `Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("Process")("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER") = "wscript"\r\nWScript.Quit shell.Run("""${scriptPath}""", 0, True)\r\n`
        : `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`;
  await fs.writeFile(
    startupPath,
    form === "cmd"
      ? Buffer.from(content, "utf8")
      : encodeWindowsLauncherScript({ format: "vbs", content }),
  );
  return { startupPath, scriptPath, taskName };
}

describe("Windows Startup service inventory", () => {
  it.each(["cmd", "9.2/9.3", "9.4"] as const)(
    "discovers an unselected sibling from real %s launcher files",
    async (form) => {
      const { startupPath, taskName } = await startup(form);
      expect(await findGatewayServices(environment())).toEqual({
        services: [
          expect.objectContaining({
            platform: "win32",
            label: taskName,
            scope: "user",
            marker: "openclaw",
            windowsStartupEntry: startupPath,
          }),
        ],
        errors: [],
      });
    },
  );

  it("keeps a same-name Task and Startup definition distinct", async () => {
    const { startupPath, taskName } = await startup("9.4");
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      {
        taskPath: taskName,
        state: 3,
        actions: [
          { type: 0, path: "C:/Other/openclaw.exe", arguments: "gateway", workingDirectory: "" },
        ],
      },
    ]);
    const inventory = await findGatewayServices(environment());
    expect(inventory.errors).toEqual([]);
    expect(inventory.services).toHaveLength(2);
    expect(inventory.services).toContainEqual(
      expect.objectContaining({ label: taskName, scope: "system" }),
    );
    const entry = inventory.services.find((service) => service.scope === "user");
    expect(entry).toMatchObject({ label: taskName, windowsStartupEntry: startupPath });
    expect(renderGatewayServiceCleanupHints(entry ? [entry] : [])).not.toContain(
      `schtasks /Delete /TN "${taskName}" /F`,
    );
  });

  it("still inspects Startup definitions when Task Scheduler is unavailable", async () => {
    const { startupPath } = await startup("9.2/9.3");
    vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
      throw new Error("unavailable");
    });
    const inventory = await findGatewayServices(environment());
    expect(inventory.services).toContainEqual(
      expect.objectContaining({ windowsStartupEntry: startupPath }),
    );
    expect(inventory.errors).toEqual([{ source: "schtasks", message: expect.any(String) }]);
  });

  it("retains the original task identity when its Startup filename is sanitized", async () => {
    const { startupPath, scriptPath, taskName } = await startup("9.4", "\\Ops\\Recovery");
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
      status: "unknown",
      detail: "no Scheduler access",
    });
    const inventory = await findGatewayServices(environment());
    expect(inventory.errors).toEqual([]);
    expect(inventory.services).toContainEqual(
      expect.objectContaining({ label: taskName, windowsStartupEntry: startupPath }),
    );
    expect(await readStartupEntryCommand(startupPath)).toMatchObject({
      sourcePath: scriptPath,
      definitionPaths: [startupPath, scriptPath],
      programArguments: [
        "C:/Node/node.exe",
        "C:/Applications/openclaw/dist/index.js",
        "gateway",
        "--port",
        "19789",
      ],
      environment: {
        OPENCLAW_WINDOWS_TASK_NAME: taskName,
        OPENCLAW_PROFILE: "rescue",
        OPENCLAW_STATE_DIR: path.dirname(scriptPath),
      },
    });
  });

  it.each(["entry", "script"] as const)(
    "rejects the %s retargeted during inspection",
    async (changed) => {
      const { startupPath, scriptPath } = await startup("9.4");
      await expect(
        readStartupEntryCommand(startupPath, {
          onLauncherContent: (content) => {
            if (content.includes("OPENCLAW_SERVICE_KIND")) {
              writeFileSync(
                changed === "entry" ? startupPath : scriptPath,
                "changed after capture",
              );
            }
          },
        }),
      ).rejects.toThrow("Startup service command could not be inspected.");
    },
  );

  it("reports recognizable malformed and unreadable entries without treating unrelated files as Gateways", async () => {
    const env = { ...environment(), OPENCLAW_WINDOWS_TASK_NAME: "Selected Custom" };
    const directory = path.dirname(resolveStartupEntryPath(env));
    await fs.mkdir(directory, { recursive: true });
    const selected = resolveStartupEntryPath(env, "vbs");
    const branded = path.join(directory, "Private Alias.vbs");
    const unreadable = path.join(directory, "OpenClaw Gateway Broken.cmd");
    await fs.writeFile(selected, "unrecognized");
    await fs.writeFile(branded, "' OpenClaw Gateway\r\nunrecognized");
    await fs.mkdir(unreadable);
    await fs.writeFile(path.join(directory, "Other.vbs"), "unrecognized");
    const inventory = await findGatewayServices(env);
    expect(inventory.services).toEqual([]);
    expect(inventory.errors.map(({ source }) => source).toSorted()).toEqual(
      [selected, branded, unreadable].toSorted(),
    );
  });

  it("distinguishes a missing Startup directory from inaccessible discovery", async () => {
    const env = environment();
    expect(await findGatewayServices(env)).toEqual({ services: [], errors: [] });
    await fs.writeFile(env.APPDATA, "not a directory");
    expect(await findGatewayServices(env)).toEqual({
      services: [],
      errors: [{ source: path.dirname(resolveStartupEntryPath(env)), message: expect.any(String) }],
    });
  });

  it("reports a non-directory ancestor when Windows labels it missing", async () => {
    const env = environment();
    await fs.writeFile(env.APPDATA, "not a directory");
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("scandir failed"), { code: "ENOENT" }),
    );
    expect(await findGatewayServices(env)).toEqual({
      services: [],
      errors: [{ source: path.dirname(resolveStartupEntryPath(env)), message: expect.any(String) }],
    });
  });

  it.each([false, true])(
    "distinguishes missing Startup children from a dangling directory link (target exists=%s)",
    async (targetExists) => {
      const env = environment();
      const target = path.resolve(root, "redirected-appdata");
      if (targetExists) {
        await fs.mkdir(target);
      }
      await fs.symlink(target, env.APPDATA, "junction");
      expect(await findGatewayServices(env)).toEqual({
        services: [],
        errors: targetExists
          ? []
          : [{ source: path.dirname(resolveStartupEntryPath(env)), message: expect.any(String) }],
      });
    },
  );

  it("reports an unreadable Startup directory instead of treating it as absent", async () => {
    const env = environment();
    const directory = path.dirname(resolveStartupEntryPath(env));
    await fs.mkdir(directory, { recursive: true });
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("access denied"), { code: "EACCES" }),
    );
    expect(await findGatewayServices(env)).toEqual({
      services: [],
      errors: [{ source: directory, message: expect.any(String) }],
    });
  });

  it("reports an unavailable Startup folder locator instead of claiming complete discovery", async () => {
    expect(await findGatewayServices({})).toEqual({
      services: [],
      errors: [{ source: "startup", message: expect.any(String) }],
    });
  });
});
