// Daemon inspect tests cover service inspection and diagnostic output.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  detectMarkerLineWithGateway,
  findExtraGatewayServices,
  findGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";
import * as taskLayout from "./schtasks-layout.js";
import * as taskProbe from "./schtasks-state-probe.js";

const nativePlistHost = vi.hoisted(() => process.platform === "darwin");
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  const { decodeLaunchAgentPlistFixture } = await import("./launchd-plist.test-support.js");
  return {
    ...actual,
    runExec: vi.fn(async (...args: Parameters<typeof actual.runExec>) => {
      if (nativePlistHost) {
        return actual.runExec(...args);
      }
      const options = args[2];
      const input = typeof options === "object" ? options.input : undefined;
      if (input === undefined) {
        throw new Error("Native parser requires captured plist bytes");
      }
      return decodeLaunchAgentPlistFixture(input, args[1][1]);
    }),
  };
});

// File-scope cleanup cannot prevent the nested platform-restoration hooks from running.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Real content from the openclaw-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/openclaw/.npm-global/lib/node_modules/openclaw/dist/entry.js gateway --port 18789
Restart=always
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway

[Install]
WantedBy=default.target
`;

// Real content from the openclaw-test.service unit file (a non-gateway openclaw service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;

const COMPANION_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw companion worker
After=openclaw-gateway.service
Requires=openclaw-gateway.service

[Service]
ExecStart=/usr/bin/node /opt/openclaw-worker/dist/index.js worker
`;

const CUSTOM_OPENCLAW_GATEWAY_CONTENTS = `\
[Unit]
Description=Custom OpenClaw gateway

[Service]
ExecStart=/usr/bin/node /opt/openclaw/dist/entry.js gateway --port 18888
`;

describe("detectMarkerLineWithGateway", () => {
  it("returns null for openclaw-test.service (openclaw only in description, no gateway on same line)", () => {
    expect(detectMarkerLineWithGateway(TEST_SERVICE_CONTENTS)).toBeNull();
  });

  it("returns openclaw for the canonical gateway unit (ExecStart has both openclaw and gateway)", () => {
    expect(detectMarkerLineWithGateway(GATEWAY_SERVICE_CONTENTS)).toBe("openclaw");
  });

  it("returns clawdbot for a clawdbot gateway unit", () => {
    expect(detectMarkerLineWithGateway(CLAWDBOT_GATEWAY_CONTENTS)).toBe("clawdbot");
  });

  it.each([
    "ExecStart=/usr/bin/openclaw \\\n  gateway",
    "# comment \\\nExecStart=/usr/bin/openclaw gateway",
    "; comment \\\nExecStart=/usr/bin/openclaw gateway",
    "ExecStart=/usr/bin/openclaw \\\n# comment\n  gateway",
  ])("detects commands through native comments and continuations: %s", (command) => {
    expect(detectMarkerLineWithGateway(`[Service]\n${command}\n`)).toBe("openclaw");
  });

  it.each(["After", "Requires", "Description", "Environment"])(
    "ignores gateway mentions in %s instead of an executable directive",
    (key) => {
      expect(detectMarkerLineWithGateway(`${key}=openclaw gateway\n`)).toBeNull();
    },
  );

  it("ignores dependency-only references to the gateway unit", () => {
    expect(detectMarkerLineWithGateway(COMPANION_SERVICE_CONTENTS)).toBeNull();
  });

  it("ignores non-gateway ExecStart commands that only pass gateway-named options", () => {
    const contents = `[Service]\nExecStart=/usr/bin/openclaw-helper --gateway-url http://127.0.0.1:18789 sync\n`;
    expect(detectMarkerLineWithGateway(contents)).toBeNull();
  });
});

describe("renderGatewayServiceCleanupHints", () => {
  it("does not suggest removing a gateway when no extra service was detected", () => {
    expect(renderGatewayServiceCleanupHints([])).toEqual([]);
  });

  it.each([
    {
      title: "targets the detected macOS LaunchAgent instead of the active gateway",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "uses the system domain for a detected macOS LaunchDaemon",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "sudo launchctl bootout system/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchDaemons/com.example.openclaw-gateway.plist",
    },
    {
      title: "keeps global macOS LaunchAgents in the GUI domain",
      platform: "darwin",
      serviceName: "com.example.openclaw-gateway",
      source: "plist: /Library/LaunchAgents/com.example.openclaw-gateway.plist",
      scope: "system",
      firstHint: "launchctl bootout gui/$UID/com.example.openclaw-gateway",
      secondHint: "sudo rm /Library/LaunchAgents/com.example.openclaw-gateway.plist",
    },
    {
      title: "inspects the detected user-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- custom-gateway.service",
      secondHint: "systemctl --user cat -- custom-gateway.service",
    },
    {
      title: "inspects the detected system-level systemd unit without removing it",
      platform: "linux",
      serviceName: "custom-gateway.service",
      source: "unit: /etc/systemd/system/custom-gateway.service",
      scope: "system",
      firstHint: "systemctl --system status -- custom-gateway.service",
      secondHint: "systemctl --system cat -- custom-gateway.service",
    },
    {
      title: "terminates systemctl options before a detected unit that begins with a dash",
      platform: "linux",
      serviceName: "-custom-gateway.service",
      source: "unit: /home/test/.config/systemd/user/-custom-gateway.service",
      scope: "user",
      firstHint: "systemctl --user status -- -custom-gateway.service",
      secondHint: "systemctl --user cat -- -custom-gateway.service",
    },
    {
      title: "shell-quotes detected POSIX service labels and paths",
      platform: "darwin",
      serviceName: "com.example.gateway; touch injected",
      source: "plist: /Users/test/Launch Agents/example's gateway.plist",
      scope: "user",
      firstHint: "launchctl bootout gui/$UID/'com.example.gateway; touch injected'",
      secondHint: "rm '/Users/test/Launch Agents/example'\\''s gateway.plist'",
    },
  ] as const)("$title", ({ platform, serviceName, source, scope, firstHint, secondHint }) => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform,
          label: serviceName,
          detail: source,
          scope,
        },
      ]),
    ).toEqual([firstHint, secondHint]);
  });

  it("targets the detected Windows scheduled task", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "win32",
          label: "\\OpenClaw Gateway Backup",
          detail: "task: \\OpenClaw Gateway Backup",
          scope: "system",
        },
      ]),
    ).toEqual(['schtasks /Delete /TN "\\OpenClaw Gateway Backup" /F']);
  });

  it.each(["$(Start-Process calc)", "%OPENCLAW_GATEWAY_TASK%", "unsafe&task", "task`name"])(
    "does not render a Windows task name expandable by cmd.exe or PowerShell: %s",
    (label) => {
      expect(
        renderGatewayServiceCleanupHints([
          {
            platform: "win32",
            label,
            detail: `task: ${label}`,
            scope: "system",
          },
        ]),
      ).toEqual([]);
    },
  );

  it("does not invent a removal path when service metadata omits it", () => {
    expect(
      renderGatewayServiceCleanupHints([
        {
          platform: "darwin",
          label: "com.example.openclaw-gateway",
          detail: "loaded",
          scope: "user",
        },
      ]),
    ).toEqual(["launchctl bootout gui/$UID/com.example.openclaw-gateway"]);
  });
});

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("does not report openclaw-test.service as a gateway service", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(path.join(systemdDir, "openclaw-test.service"), TEST_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it("discovers the default and named profiles without reporting them as extra services", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(path.join(systemdDir, "openclaw-gateway.service"), GATEWAY_SERVICE_CONTENTS);
    await fs.writeFile(
      path.join(systemdDir, "openclaw-gateway-ops.service"),
      GATEWAY_SERVICE_CONTENTS,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
    const inventory = await findGatewayServices({ HOME: tmpHome });
    expect(inventory.errors).toEqual([]);
    expect(inventory.services.map((service) => service.label)).toEqual([
      "openclaw-gateway-ops.service",
      "openclaw-gateway.service",
    ]);
  });

  it("reports a legacy clawdbot-gateway service as an extra gateway service", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${unitPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("reports an orphaned legacy systemd backup", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const backupPath = path.join(systemdDir, "clawdbot-gateway.service.bak");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(backupPath, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit backup: ${backupPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
    expect(await findGatewayServices({ HOME: tmpHome })).toEqual({ services: [], errors: [] });
  });

  it("reports a legacy systemd unit and its backup once", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    const unitPath = path.join(systemdDir, "clawdbot-gateway.service");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
    await fs.writeFile(`${unitPath}.bak`, CLAWDBOT_GATEWAY_CONTENTS);

    const result = await findExtraGatewayServices({ HOME: tmpHome });

    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${unitPath}`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("does not report companion units that only depend on the gateway", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(
      path.join(systemdDir, "openclaw-companion.service"),
      COMPANION_SERVICE_CONTENTS,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it.each(["", "# comment \\\n", "; comment \\\n"])(
    "reports custom-named gateway units after a physical comment: %j",
    async (comment) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "custom-openclaw.service");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        unitPath,
        CUSTOM_OPENCLAW_GATEWAY_CONTENTS.replace("ExecStart=", `${comment}ExecStart=`),
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toEqual([
        {
          platform: "linux",
          label: "custom-openclaw.service",
          detail: `unit: ${unitPath}`,
          scope: "user",
          marker: "openclaw",
          legacy: false,
        },
      ]);
      expect((await findGatewayServices({ HOME: tmpHome })).services).toEqual(result);
    },
  );
});

describe("findExtraGatewayServices (darwin / scanLaunchdDir) — real filesystem", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("discovers default and named LaunchAgents without reporting them as extra services", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    const labels = ["ai.openclaw.gateway", "ai.openclaw.ops"];
    await fs.mkdir(launchdDir, { recursive: true });
    for (const label of labels) {
      await fs.writeFile(
        path.join(launchdDir, `${label}.plist`),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string></array>
</dict></plist>`,
      );
    }

    expect(await findExtraGatewayServices({ HOME: tmpHome })).toEqual([]);
    const inventory = await findGatewayServices({ HOME: tmpHome });
    expect(inventory.errors).toEqual([]);
    expect(inventory.services.map((service) => service.label)).toEqual(labels);
  });

  it("does not report LaunchAgent companions that only mention the gateway label", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion</string>
<key>KeepAlive</key><dict><key>OtherJobEnabled</key><dict><key>ai.openclaw.gateway</key><true/></dict></dict>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it("does not report LaunchAgent companions that only pass gateway-named options", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.example.companion-options.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.example.companion-options</string>
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw-helper</string><string>--gateway-url</string><string>http://127.0.0.1:18789</string><string>sync</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it("does not report non-gateway LaunchAgents that mention clawdbot in environment values", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
    await fs.mkdir(launchdDir, { recursive: true });
    await fs.writeFile(
      path.join(launchdDir, "com.github.facebook.watchman.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.github.facebook.watchman</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/Users/test/Projects/clawdbot2/node_modules/.bin:/opt/homebrew/bin</string></dict>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/watchman</string><string>--foreground</string></array>
</dict></plist>`,
    );
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it.each([
    { xmlLabel: "com.example.openclaw-gateway", label: "com.example.openclaw-gateway" },
    { xmlLabel: "org.synthetic.a&amp;b", label: "org.synthetic.a&b" },
    { xmlLabel: "", label: "com.example.openclaw-gateway" },
    { xmlLabel: undefined, label: "com.example.openclaw-gateway" },
  ])(
    "reports custom LaunchAgents with decoded or absent labels: $xmlLabel",
    async ({ xmlLabel, label }) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const launchdDir = path.join(tmpHome, "Library", "LaunchAgents");
      const plistPath = path.join(launchdDir, "com.example.openclaw-gateway.plist");
      await fs.mkdir(launchdDir, { recursive: true });
      await fs.writeFile(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
${xmlLabel === undefined ? "" : `<key>Label</key><string>${xmlLabel}</string>`}
<key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string><string>--port</string><string>18888</string></array>
</dict></plist>`,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toEqual([
        {
          platform: "darwin",
          label,
          detail: `plist: ${plistPath}`,
          scope: "user",
          marker: "openclaw",
          legacy: false,
        },
      ]);
      expect(renderGatewayServiceCleanupHints(result)).toEqual([
        `launchctl bootout gui/$UID/${label.includes("&") ? `'${label}'` : label}`,
        `rm ${plistPath}`,
      ]);
      expect((await findGatewayServices({ HOME: tmpHome })).services).toEqual(result);
    },
  );
});

describe.skipIf(!nativePlistHost)("malformed native LaunchAgent discovery", () => {
  it.each([
    { kind: "unrelated", name: "com.vendor.helper", marked: false, selected: false, utf16: false },
    { kind: "Gateway name", name: "ai.openclaw.ops", marked: false, selected: false, utf16: false },
    {
      kind: "selected custom",
      name: "com.vendor.helper",
      marked: false,
      selected: true,
      utf16: false,
    },
    {
      kind: "marked custom",
      name: "com.vendor.helper",
      marked: true,
      selected: false,
      utf16: false,
    },
    {
      kind: "UTF-16 marked custom",
      name: "com.vendor.helper",
      marked: true,
      selected: false,
      utf16: true,
    },
  ])(
    "scopes malformed plist failures by Gateway relevance: $kind",
    async ({ kind, name, marked, selected, utf16 }) => {
      const tmpHome = tempDirs.make("openclaw-malformed-plist-", os.tmpdir());
      const serviceDir = path.join(tmpHome, "Library", "LaunchAgents");
      const brokenPath = path.join(serviceDir, `${name}.plist`);
      const label = "ai.openclaw.gateway";
      await fs.mkdir(serviceDir, { recursive: true });
      await fs.writeFile(
        path.join(serviceDir, `${label}.plist`),
        `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string></array></dict></plist>`,
      );
      const malformed = `<plist><dict><key>Label</key><string>${name}</string>${marked ? "<key>Program</key><string>/opt/OpenClaw/bin/gateway</string>" : ""}`;
      await fs.writeFile(
        brokenPath,
        utf16 ? Buffer.from(`\uFEFF${malformed}`, "utf16le") : malformed,
      );

      const inventory = await findGatewayServices({
        HOME: tmpHome,
        ...(selected ? { OPENCLAW_LAUNCHD_LABEL: name } : {}),
      });
      expect(inventory.services.map((service) => service.label)).toEqual([label]);
      expect(inventory.errors).toEqual(
        kind === "unrelated" ? [] : [{ source: brokenPath, message: expect.any(String) }],
      );
    },
  );
});

describe.each([
  { platform: "linux", directory: [".config", "systemd", "user"], extension: ".service" },
  { platform: "darwin", directory: ["Library", "LaunchAgents"], extension: ".plist" },
])("findGatewayServices errors ($platform)", ({ platform, directory, extension }) => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("distinguishes a missing service directory from a directory that cannot be enumerated", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const serviceDir = path.join(tmpHome, ...directory);
    expect(await findGatewayServices({ HOME: tmpHome })).toEqual({ services: [], errors: [] });

    await fs.mkdir(path.dirname(serviceDir), { recursive: true });
    await fs.writeFile(serviceDir, "not a directory");
    const inventory = await findGatewayServices({ HOME: tmpHome });
    expect(inventory.services).toEqual([]);
    expect(inventory.errors).toEqual([{ source: serviceDir, message: expect.any(String) }]);
    expect(await findExtraGatewayServices({ HOME: tmpHome })).toEqual([]);
  });

  it.each(
    [
      { kind: "unrelated", brokenName: "com.example.unrelated" },
      { kind: "selected custom", brokenName: "com.example.unrelated" },
      {
        kind: "gateway",
        brokenName: platform === "linux" ? "openclaw-gateway-ops" : "ai.openclaw.ops",
      },
      ...(platform === "linux"
        ? [
            "openclaw",
            "openclaw@",
            "openclaw@ops",
            "openclaw-gateway@",
            "openclaw-gateway@ops",
          ].map((brokenName) => ({ kind: "gateway", brokenName }))
        : []),
    ].flatMap(({ kind, brokenName }) =>
      ["directory", "dangling link"].map((fault) => ({ kind, brokenName, fault })),
    ),
  )(
    "scopes unreadable definitions by Gateway relevance: $kind ($brokenName, $fault)",
    async ({ kind, brokenName, fault }) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const serviceDir = path.join(tmpHome, ...directory);
      const brokenPath = path.join(serviceDir, `${brokenName}${extension}`);
      if (fault === "dangling link") {
        await fs.mkdir(serviceDir, { recursive: true });
        await fs.symlink(path.join(serviceDir, "missing-target"), brokenPath, "junction");
      } else {
        await fs.mkdir(brokenPath, { recursive: true });
      }
      const label = platform === "linux" ? "openclaw-gateway.service" : "ai.openclaw.gateway";
      await fs.writeFile(
        path.join(serviceDir, platform === "linux" ? label : `${label}.plist`),
        platform === "linux"
          ? GATEWAY_SERVICE_CONTENTS
          : `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/local/bin/openclaw</string><string>gateway</string></array></dict></plist>`,
      );

      const selector = platform === "linux" ? "OPENCLAW_SYSTEMD_UNIT" : "OPENCLAW_LAUNCHD_LABEL";
      const inventory = await findGatewayServices({
        HOME: tmpHome,
        ...(kind === "selected custom" ? { [selector]: brokenName } : {}),
      });
      expect(inventory.services.map((service) => service.label)).toEqual([label]);
      expect(inventory.errors).toEqual(
        kind === "unrelated" ? [] : [{ source: brokenPath, message: expect.any(String) }],
      );
    },
  );
});

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;
  let nativeEnv: { APPDATA: string };
  const task = (taskPath: string, actionPath: string, args = "") => ({
    taskPath,
    state: 3,
    actions: [{ type: 0, path: actionPath, arguments: args, workingDirectory: "" }],
  });

  beforeEach(() => {
    nativeEnv = { APPDATA: tempDirs.make("openclaw-windows-inventory-") };
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  });

  it("skips native queries unless deep mode is enabled", async () => {
    expect(await findExtraGatewayServices({})).toEqual([]);
    expect(taskProbe.listScheduledTasks).not.toHaveBeenCalled();
  });

  it.each(["query denied", "missing executable"])(
    "exposes inventory query failure: %s",
    async (failure) => {
      vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
        throw new Error(failure);
      });
      expect(await findExtraGatewayServices(nativeEnv, { deep: true })).toEqual([]);
      expect(await findGatewayServices(nativeEnv)).toEqual({
        services: [],
        errors: [{ source: "schtasks", message: expect.any(String) }],
      });
    },
  );

  it("collects only non-managed marker tasks from native metadata", async () => {
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\OpenClaw Gateway", "C:\\Program Files\\OpenClaw\\openclaw.exe", "gateway run"),
      task("Clawdbot Legacy", "C:\\clawdbot\\clawdbot.exe", "run"),
      task("Other Task", "C:\\tools\\helper.exe"),
    ]);
    expect(await findExtraGatewayServices(nativeEnv, { deep: true })).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("keeps Node helpers in diagnostics while inventorying only Gateway candidates", async () => {
    const gatewayPath = "C:\\Program Files\\OpenClaw\\openclaw.exe";
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\OpenClaw Gateway", gatewayPath, "gateway run"),
      task("\\OpenClaw Gateway (dev)", gatewayPath, "gateway run --profile dev"),
      task("\\OpenClaw Gateway Backup", gatewayPath, "gateway run"),
      task("\\OpenClaw Node", "C:\\Users\\test\\.openclaw\\node.vbs"),
    ]);
    vi.spyOn(taskLayout, "readScheduledTaskCommand").mockResolvedValue({
      programArguments: ["node", "openclaw.mjs", "node", "run"],
      environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
    });
    const extras = await findExtraGatewayServices(nativeEnv, { deep: true });
    expect(extras).toEqual([
      {
        platform: "win32",
        label: "\\OpenClaw Gateway Backup",
        detail: `task: \\OpenClaw Gateway Backup, run: ${gatewayPath} gateway run`,
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
      {
        platform: "win32",
        label: "\\OpenClaw Node",
        detail: "task: \\OpenClaw Node, run: C:\\Users\\test\\.openclaw\\node.vbs",
        scope: "system",
        marker: "openclaw",
        legacy: false,
      },
    ]);
    const inventory = await findGatewayServices(nativeEnv);
    expect(inventory.errors).toEqual([]);
    expect(inventory.services.map((service) => service.label)).toEqual([
      "\\OpenClaw Gateway",
      "\\OpenClaw Gateway (dev)",
      "\\OpenClaw Gateway Backup",
    ]);
  });

  it("discovers a nested custom task from its launcher contents", async () => {
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\Ops\\Backup", "C:\\Services\\Backup\\gateway.cmd"),
      task("\\Unrelated", "C:\\Tools\\helper.exe"),
    ]);
    vi.spyOn(taskLayout, "readScheduledTaskCommand").mockResolvedValue({
      programArguments: ["node", "C:\\Applications\\openclaw\\openclaw.mjs", "gateway"],
      environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
    });
    expect(await findGatewayServices(nativeEnv)).toEqual({
      services: [
        {
          platform: "win32",
          label: "\\Ops\\Backup",
          detail: "task: \\Ops\\Backup, run: C:\\Services\\Backup\\gateway.cmd",
          scope: "system",
          marker: "openclaw",
          legacy: false,
        },
      ],
      errors: [],
    });
    expect(taskLayout.readScheduledTaskCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ OPENCLAW_WINDOWS_TASK_NAME: "\\Ops\\Backup" }),
      expect.objectContaining({ requireEffective: true, requireLoaded: true }),
    );
  });

  it.each(
    ["recognizable", "legacy", "selected", "unrelated"].flatMap((kind) =>
      ["missing action", "unreadable launcher"].map((fault) => ({ kind, fault })),
    ),
  )(
    "keeps $kind $fault handling scoped while preserving diagnostic metadata",
    async ({ kind, fault }) => {
      const name =
        kind === "recognizable"
          ? "\\OpenClaw Gateway Backup"
          : kind === "legacy"
            ? "\\Clawdbot Gateway Legacy"
            : "\\Ops\\Backup";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
        fault === "missing action"
          ? { taskPath: name, state: 3 }
          : task(name, "C:\\Services\\Backup\\gateway.cmd"),
      ]);
      vi.spyOn(taskLayout, "readScheduledTaskCommand").mockRejectedValue(new Error("unreadable"));
      const env =
        kind === "selected" ? { ...nativeEnv, OPENCLAW_WINDOWS_TASK_NAME: name } : nativeEnv;
      const inventory = await findGatewayServices(env);
      expect(inventory.services).toEqual([]);
      expect(inventory.errors).toEqual(
        kind === "unrelated" ? [] : [{ source: name, message: expect.any(String) }],
      );
      const extras = await findExtraGatewayServices(env, { deep: true });
      expect(extras.map(({ label }) => label)).toEqual(
        kind === "recognizable" || kind === "legacy" ? [name] : [],
      );
    },
  );

  it("keeps a custom Gateway identifiable when its native wrapper is ambiguous", async () => {
    const name = "\\Ops\\Backup";
    const launcher = "C:\\Services\\Backup\\launch.vbs";
    const snapshot = task(name, launcher);
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([snapshot]);
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({
      status: "found",
      ...snapshot,
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      if (pathname !== launcher) {
        throw new Error("Unexpected fixture path");
      }
      return Buffer.from(
        'CreateObject("WScript.Shell").Run "node C:\\Applications\\openclaw\\openclaw.mjs gateway", 0, False',
      );
    });
    expect(await findGatewayServices(nativeEnv)).toEqual({
      services: [],
      errors: [{ source: name, message: expect.any(String) }],
    });
  });
});
