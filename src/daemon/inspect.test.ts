// Daemon inspect tests cover service inspection and diagnostic output.
import { execFileSync } from "node:child_process";
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
import { readLaunchAgentProgramArgumentsFromFile } from "./launchd-plist.js";
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
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("does not report openclaw-test.service as a gateway service", async () => {
    const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    await fs.mkdir(systemdDir, { recursive: true });
    await fs.writeFile(path.join(systemdDir, "openclaw-test.service"), TEST_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME: tmpHome });
    expect(result).toStrictEqual([]);
  });

  it.skipIf(!isLinux)(
    "discovers the default and named profiles without reporting them as extra services",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-gateway.service"),
        GATEWAY_SERVICE_CONTENTS,
      );
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
    },
  );

  it.skipIf(!isLinux)(
    "reports a legacy clawdbot-gateway service as an extra gateway service",
    async () => {
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
    },
  );

  it.skipIf(!isLinux)("reports an orphaned legacy systemd backup", async () => {
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

  it.skipIf(!isLinux)("reports a legacy systemd unit and its backup once", async () => {
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

  it.skipIf(!isLinux)(
    "does not report companion units that only depend on the gateway",
    async () => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(
        path.join(systemdDir, "openclaw-companion.service"),
        COMPANION_SERVICE_CONTENTS,
      );
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toStrictEqual([]);
    },
  );

  it.skipIf(!isLinux).each(["", "# comment \\\n", "; comment \\\n"])(
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

  it.skipIf(!nativePlistHost).each(["xml1", "binary1"])(
    "discovers commands despite unrelated native date/data fields in %s plists",
    async (format) => {
      const home = tempDirs.make("native-plist-metadata-", os.tmpdir());
      const directory = path.join(home, "Library", "LaunchAgents");
      await fs.mkdir(directory, { recursive: true });
      for (const [label, executable, subcommand] of [
        ["org.synthetic.foreign", "/usr/bin/worker", "sync"],
        ["org.synthetic.gateway", "/usr/bin/openclaw", "gateway"],
      ]) {
        const fixture = path.join(directory, `${label}.plist`);
        await fs.writeFile(
          fixture,
          `<plist><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${executable}</string><string>${subcommand}</string></array>
<key>Payload</key><data>c3ludGhldGlj</data>
<key>Created</key><date>2026-09-17T00:00:00Z</date>
<key>EnvironmentVariables</key><dict><key>LITERAL</key><string>&lt;data&gt;preserve literal text&lt;/data&gt;</string></dict>
</dict></plist>`,
        );
        execFileSync("/usr/bin/plutil", ["-convert", format, "--", fixture]);
      }
      expect(await findGatewayServices({ HOME: home })).toEqual({
        services: [expect.objectContaining({ label: "org.synthetic.gateway", marker: "openclaw" })],
        errors: [],
      });
      const command = await readLaunchAgentProgramArgumentsFromFile(
        path.join(directory, "org.synthetic.gateway.plist"),
        { requireEffective: true, expectedLabel: "org.synthetic.gateway" },
      );
      expect(command?.environment?.LITERAL).toBe("<data>preserve literal text</data>");
    },
  );

  it
    .skipIf(!nativePlistHost)
    .each(
      [
        "Label",
        "ProgramArguments",
        "WorkingDirectory",
        "EnvironmentVariables",
        "environment entry",
      ].flatMap((field) => ["data", "date"].map((scalar) => ({ field, scalar }))),
    )("rejects native $scalar in the strict $field contract", async ({ field, scalar }) => {
    const home = tempDirs.make("native-plist-invalid-field-", os.tmpdir());
    const fixture = path.join(home, "gateway.plist");
    const value =
      scalar === "data" ? "<data>c3ludGhldGlj</data>" : "<date>2026-09-17T00:00:00Z</date>";
    const fields = new Map([
      ["Label", "<string>org.synthetic.gateway</string>"],
      [
        "ProgramArguments",
        "<array><string>/usr/bin/openclaw</string><string>gateway</string></array>",
      ],
    ]);
    fields.set(
      field === "environment entry" ? "EnvironmentVariables" : field,
      field === "environment entry" ? `<dict><key>INVALID</key>${value}</dict>` : value,
    );
    await fs.writeFile(
      fixture,
      `<plist><dict>${Array.from(fields, ([key, element]) => `<key>${key}</key>${element}`).join("")}</dict></plist>`,
    );
    await expect(
      readLaunchAgentProgramArgumentsFromFile(fixture, {
        requireEffective: true,
        expectedLabel: "org.synthetic.gateway",
      }),
    ).rejects.toThrow("Effective LaunchAgent service command could not be inspected");
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

  it.each(["unrelated", "gateway", "selected custom"])(
    "scopes unreadable definitions by Gateway relevance: %s",
    async (kind) => {
      const tmpHome = tempDirs.make("openclaw-test-", os.tmpdir());
      const serviceDir = path.join(tmpHome, ...directory);
      const brokenName =
        kind === "gateway"
          ? platform === "linux"
            ? "openclaw-gateway-ops"
            : "ai.openclaw.ops"
          : "com.example.unrelated";
      const brokenPath = path.join(serviceDir, `${brokenName}${extension}`);
      await fs.mkdir(brokenPath, { recursive: true });
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
  const task = (taskPath: string, actionPath: string, args = "") => ({
    taskPath,
    state: 3,
    actions: [{ type: 0, path: actionPath, arguments: args, workingDirectory: "" }],
  });

  beforeEach(() => {
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
      expect(await findExtraGatewayServices({}, { deep: true })).toEqual([]);
      expect(await findGatewayServices({})).toEqual({
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
    expect(await findExtraGatewayServices({}, { deep: true })).toEqual([
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
    const extras = await findExtraGatewayServices({}, { deep: true });
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
    const inventory = await findGatewayServices({});
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
    expect(await findGatewayServices({})).toEqual({
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

  it.each(["recognizable", "selected", "unrelated"] as const)(
    "keeps %s unreadable launcher handling scoped",
    async (kind) => {
      const name = kind === "recognizable" ? "\\OpenClaw Gateway Backup" : "\\Ops\\Backup";
      vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
        task(name, "C:\\Services\\Backup\\gateway.cmd"),
      ]);
      vi.spyOn(taskLayout, "readScheduledTaskCommand").mockRejectedValue(new Error("unreadable"));
      const inventory = await findGatewayServices(
        kind === "selected" ? { OPENCLAW_WINDOWS_TASK_NAME: name } : {},
      );
      expect(inventory.services).toEqual([]);
      expect(inventory.errors).toEqual(
        kind === "unrelated" ? [] : [{ source: name, message: expect.any(String) }],
      );
    },
  );

  it("keeps a custom Gateway identifiable when its readable launcher is ambiguous", async () => {
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\Ops\\Backup", "C:\\Services\\Backup\\gateway.cmd"),
    ]);
    vi.spyOn(taskLayout, "readScheduledTaskCommand").mockImplementation(async (_env, options) => {
      options?.onLauncherContent?.(
        'node "C:\\Applications\\openclaw\\openclaw.mjs" gateway\r\nnode other.js',
      );
      throw new Error("ambiguous launcher");
    });
    expect(await findGatewayServices({})).toEqual({
      services: [],
      errors: [{ source: "\\Ops\\Backup", message: expect.any(String) }],
    });
  });
});
