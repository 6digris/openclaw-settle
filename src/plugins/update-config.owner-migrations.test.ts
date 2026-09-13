import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyPluginInstallOwnerMigrations,
  restorePluginConfigMigrationReferences,
} from "./update-config.js";

describe("committed plugin owner config migrations", () => {
  it("leaves an empty config unchanged when only install records changed owners", () => {
    const config: OpenClawConfig = {};
    const migrations = { retired: "canonical" };
    const result = applyPluginInstallOwnerMigrations(config, migrations);
    expect(result).toEqual({ config, changes: [] });
    expect(result.config).toBe(config);
    expect(
      restorePluginConfigMigrationReferences(config, {
        authoredConfig: {},
        resolvedConfig: {},
        migrations,
      }),
    ).toBe(config);
  });

  it("keeps canonical values, converges policy ids, and leaves channel owners unchanged", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          retired: { enabled: true, config: { token: "old" } },
          canonical: { enabled: false, config: { token: "canonical" } },
        },
        installs: {
          retired: { source: "npm", spec: "@example/retired" },
          canonical: { source: "npm", spec: "@example/canonical" },
        },
        allow: ["retired", "other", "canonical"],
        deny: ["canonical", "retired"],
        slots: { memory: "retired", contextEngine: "retired" },
      },
      channels: { discord: { enabled: false } },
    };
    const original = structuredClone(config);
    const result = applyPluginInstallOwnerMigrations(config, { retired: "canonical" });

    expect(result.config.plugins).toEqual({
      entries: { canonical: config.plugins?.entries?.canonical },
      installs: { canonical: config.plugins?.installs?.canonical },
      allow: ["canonical", "other"],
      deny: ["canonical"],
      slots: { memory: "canonical", contextEngine: "canonical" },
    });
    expect(result.config.channels).toBe(config.channels);
    expect(config).toEqual(original);
    expect(result.changes).toHaveLength(1);
    expect(applyPluginInstallOwnerMigrations(result.config, { retired: "canonical" })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it.each([undefined, {}, { canonical: "canonical" }])(
    "does not change config without a relevant committed mapping",
    (migrations) => {
      const config: OpenClawConfig = {
        plugins: { entries: { canonical: { config: { token: "unchanged" } } } },
      };
      const result = applyPluginInstallOwnerMigrations(config, migrations);
      expect(result.config).toBe(config);
      expect(result.changes).toEqual([]);
    },
  );

  it.each([false, true])(
    "projects references from the same read with canonical precedence (canonical: %s)",
    (canonical) => {
      const authoredConfig: OpenClawConfig = {
        plugins: {
          entries: {
            retired: {
              config: { token: "${PLUGIN_TOKEN}", list: ["${PLUGIN_TOKEN}"], nullable: null },
            },
            ...(canonical
              ? { canonical: { config: { token: "${CANONICAL_TOKEN}", nullable: null } } }
              : {}),
          },
        },
      };
      const resolvedConfig: OpenClawConfig = {
        plugins: {
          entries: {
            retired: {
              config: { token: "planning-token", list: ["planning-token"], nullable: null },
            },
            ...(canonical
              ? { canonical: { config: { token: "planning-token", nullable: null } } }
              : {}),
          },
        },
      };
      const migrations = { retired: "canonical" };
      const candidate = applyPluginInstallOwnerMigrations(resolvedConfig, migrations).config;
      const projected = restorePluginConfigMigrationReferences(candidate, {
        authoredConfig,
        resolvedConfig,
        migrations,
      });
      expect(projected.plugins?.entries?.canonical?.config).toEqual(
        authoredConfig.plugins?.entries?.[canonical ? "canonical" : "retired"]?.config,
      );
      expect(candidate.plugins?.entries?.canonical?.config).toEqual(
        resolvedConfig.plugins?.entries?.[canonical ? "canonical" : "retired"]?.config,
      );
    },
  );

  it("keeps deliberate candidate edits and canonical policy instead of reusing old references", () => {
    const authoredConfig: OpenClawConfig = {
      plugins: {
        allow: ["${PLUGIN_ID}"],
        entries: { retired: { config: { token: "${PLUGIN_TOKEN}", removed: "${OLD_TOKEN}" } } },
      },
    };
    const resolvedConfig: OpenClawConfig = {
      plugins: {
        allow: ["retired"],
        entries: { retired: { config: { token: "planning-token", removed: "old-token" } } },
      },
    };
    const candidate: OpenClawConfig = {
      plugins: {
        allow: ["canonical"],
        entries: { canonical: { config: { token: "explicit-new-token", added: null } } },
      },
    };
    expect(
      restorePluginConfigMigrationReferences(candidate, {
        authoredConfig,
        resolvedConfig,
        migrations: { retired: "canonical" },
      }),
    ).toEqual(candidate);
  });
});
