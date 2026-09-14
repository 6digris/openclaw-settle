import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import discordPackage from "../../extensions/discord/package.json" with { type: "json" };
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateOpenClawPackageInstallCompatibility } from "./install-shared.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { checkMinHostVersion } from "./min-host-version.js";

vi.unmock("../version.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["2026.5.26", "2026.9.4"])(
  "rejects the current Discord package on host %s using existing install and registry owners",
  (version) => {
    const metadata = discordPackage.openclaw;
    expect(
      checkMinHostVersion({
        currentVersion: version,
        minHostVersion: metadata.install.minHostVersion,
      }).ok,
    ).toBe(true);
    const result = validateOpenClawPackageInstallCompatibility({
      pluginId: "discord",
      packageMetadata: metadata,
      runtime: { checkMinHostVersion, resolveCompatibilityHostVersion: () => version },
    });
    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    });
    expect(result?.error).toContain(metadata.compat.pluginApi);
    const rootDir = tempDirs.make("discord-package-compat-");
    fs.copyFileSync(
      new URL("../../extensions/discord/openclaw.plugin.json", import.meta.url),
      path.join(rootDir, "openclaw.plugin.json"),
    );
    const registry = loadPluginManifestRegistryCore({
      installRecords: {},
      env: { OPENCLAW_VERSION: version },
      candidates: [
        {
          idHint: "discord",
          source: path.join(rootDir, "index.ts"),
          rootDir,
          packageDir: rootDir,
          origin: "global",
          packageName: discordPackage.name,
          packageVersion: discordPackage.version,
          packageManifest: metadata,
        },
      ],
    });
    expect(registry.plugins).toEqual([]);
    expect(
      registry.diagnostics.some((entry) =>
        entry.message.includes(`requires plugin API ${metadata.compat.pluginApi}`),
      ),
    ).toBe(true);
  },
);

it("keeps the current Discord package admitted at its existing plugin API floor", () => {
  expect(
    validateOpenClawPackageInstallCompatibility({
      pluginId: "discord",
      packageMetadata: discordPackage.openclaw,
      runtime: {
        checkMinHostVersion,
        resolveCompatibilityHostVersion: () => discordPackage.version,
      },
    }),
  ).toBeNull();
});
