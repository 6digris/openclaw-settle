import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { DuplicateAgentDirError } from "./agent-dirs.js";
import { createConfigIO, restoreEnvChangesIfUnchanged } from "./io.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import { withTempHome, writeOpenClawConfig, writeStateDirDotEnv } from "./test-helpers.js";
import { withConfigWriteLock } from "./write-lock.js";

describe("restoreEnvChangesIfUnchanged", () => {
  it("removes a newly injected key when unchanged from after snapshot", () => {
    const env = { HOME: "/tmp/test" } as Record<string, string | undefined>;
    const before = { HOME: "/tmp/test" };
    env["NEW_KEY"] = "injected";
    const after = { HOME: "/tmp/test", NEW_KEY: "injected" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.NEW_KEY).toBeUndefined();
  });

  it("restores an overwritten key back to its before value", () => {
    const env = { HOME: "/tmp/test", EXISTING: "original" } as Record<string, string | undefined>;
    const before = { HOME: "/tmp/test", EXISTING: "original" };
    env["EXISTING"] = "new-value";
    const after = { HOME: "/tmp/test", EXISTING: "new-value" };

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.EXISTING).toBe("original");
  });

  it("preserves an externally modified key even when different from before", () => {
    const env = { HOME: "/tmp/test" } as Record<string, string | undefined>;
    const before = { HOME: "/tmp/test" };
    env["KEY"] = "config-set";
    const after = { HOME: "/tmp/test", KEY: "config-set" };
    // External mutation after the after snapshot
    env["KEY"] = "external-change";

    restoreEnvChangesIfUnchanged({
      env: env as NodeJS.ProcessEnv,
      before,
      after,
    });

    expect(env.KEY).toBe("external-change");
  });
});

describe("loadConfig env restoration", () => {
  it("returns resolution facts with a valid synchronous load", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { auth: { mode: "token", token: "${MISSING_GATEWAY_TOKEN}" } },
      });
      const config = createConfigIO({
        env: { HOME: home } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      }).loadConfig();

      expect([...(getConfigResolutionFacts(config) ?? [])]).toEqual(["gateway.auth.token"]);
    });
  });

  it("restores newly set env var after INVALID_CONFIG is thrown", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { TEST_VAR: "injected-value" } },
        // gateway.port must be a number; a string triggers INVALID_CONFIG
        gateway: { port: "invalid" },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
      expect(env.TEST_VAR).toBeUndefined();
    });
  });

  it("restores overwritten env key when another config section is invalid", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { PRE_EXISTING: "new-value" } },
        gateway: { port: "invalid" },
      });

      const env = {
        HOME: home,
        PRE_EXISTING: "original-value",
      } as NodeJS.ProcessEnv;

      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.PRE_EXISTING).toBe("original-value");
      expect(() => io.loadConfig()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
      expect(env.PRE_EXISTING).toBe("original-value");
    });
  });

  it("restores env changes after non-INVALID_CONFIG error (DuplicateAgentDirError)", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { DUP_DIR_TEST_VAR: "injected-value" } },
        agents: {
          list: [
            { id: "agent-a", agentDir: "/tmp/dup-agent-dir" },
            { id: "agent-b", agentDir: "/tmp/dup-agent-dir" },
          ],
        },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
      expect(() => io.loadConfig()).toThrow(DuplicateAgentDirError);
      expect(env.DUP_DIR_TEST_VAR).toBeUndefined();
    });
  });
});

describe("readConfigFileSnapshot env restoration", () => {
  it.each([false, true])(
    "checks the source owner before loading dotenv (revoked=%s)",
    async (revoked) => {
      await withTempHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
        });
        const envKey = "OPENCLAW_TEST_SNAPSHOT_DOTENV";
        await writeStateDirDotEnv(`${envKey}=dotenv-value\n`, {
          stateDir: path.dirname(configPath),
        });
        await withEnvAsync(
          {
            [envKey]: undefined,
            OPENCLAW_STATE_DIR: path.dirname(configPath),
            OPENCLAW_CONFIG_PATH: configPath,
          },
          async () => {
            const io = createConfigIO({
              configPath,
              env: process.env,
              observe: false,
              pluginValidation: "skip",
            });
            const refusal = new Error("snapshot source owner changed");
            let current = true;
            await withConfigWriteLock(
              configPath,
              async () => {
                current = !revoked;
                const read = io.readConfigFileSnapshot();
                if (revoked) {
                  await expect(read).rejects.toBe(refusal);
                } else {
                  await expect(read).resolves.toMatchObject({ valid: true });
                }
              },
              process.env,
              () => {
                if (!current) {
                  throw refusal;
                }
              },
            );
            expect(process.env[envKey]).toBe(revoked ? undefined : "dotenv-value");
          },
        );
      });
    },
  );

  it.each(
    (["snapshot", "for-write"] as const).flatMap((entry) =>
      (["env", "invalid-restore"] as const).flatMap((boundary) =>
        [false, true].map((revoked) => ({ entry, boundary, revoked })),
      ),
    ),
  )(
    "preserves $entry reader authority at $boundary (revoked=$revoked)",
    async ({ entry, boundary, revoked }) => {
      await withTempHome(async (home) => {
        const envKey = "OPENCLAW_TEST_SNAPSHOT_ENV";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [envKey]: "config-value" } },
          gateway: { mode: "local", port: boundary === "env" ? 18789 : "invalid" },
        });
        const env: NodeJS.ProcessEnv = { HOME: home };
        const refusal = { reason: "snapshot-source-changed" };
        let current = true;
        let reachedBoundary = false;
        let valueAtBoundary: string | undefined;
        const io = createConfigIO({
          configPath,
          env,
          observe: false,
          pluginValidation: "skip",
          measure: async (name, run) => {
            if (boundary === "env" && name === "config.snapshot.read.env") {
              await Promise.resolve();
              reachedBoundary = true;
              valueAtBoundary = env[envKey];
              current = !revoked;
              try {
                return await run();
              } catch (error) {
                throw new Error("measurement replaced the authority refusal", { cause: error });
              }
            }
            const result = await run();
            if (boundary === "invalid-restore" && name === "config.snapshot.read.legacy-issues") {
              reachedBoundary = true;
              valueAtBoundary = env[envKey];
              if (revoked) {
                env[envKey] = "replacement-owner";
                current = false;
              }
            }
            return result;
          },
        });
        const read = withConfigWriteLock(
          configPath,
          async () =>
            entry === "for-write"
              ? (await io.readConfigFileSnapshotForWrite()).snapshot
              : await io.readConfigFileSnapshot(),
          env,
          () => {
            if (!current) {
              // oxlint-disable-next-line typescript/only-throw-error -- Authority callbacks may throw non-Error values; preserve the exact synchronous refusal.
              throw refusal;
            }
          },
        );
        if (revoked) {
          await expect(read).rejects.toBe(refusal);
        } else {
          await expect(read).resolves.toMatchObject({ valid: boundary === "env" });
        }
        expect(reachedBoundary).toBe(true);
        expect(valueAtBoundary).toBe(boundary === "env" ? undefined : "config-value");
        expect(env[envKey]).toBe(
          boundary === "env"
            ? revoked
              ? undefined
              : "config-value"
            : revoked
              ? "replacement-owner"
              : undefined,
        );
      });
    },
  );

  it("removes a newly injected env var after invalid snapshot validation", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { TEST_VAR: "injected-value" } },
        gateway: { port: "invalid" },
      });

      const env = { HOME: home } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(env.TEST_VAR).toBeUndefined();
    });
  });

  it.each(
    (["snapshot", "for-write"] as const).flatMap((entry) =>
      (["unchanged", "replaced", "deleted"] as const).map((change) => ({ entry, change })),
    ),
  )(
    "preserves foreign env changes during invalid $entry validation (owned=$change)",
    async ({ entry, change }) => {
      await withTempHome(async (home) => {
        const ownedKey = "OPENCLAW_TEST_READER_OWNED";
        const addedKey = "OPENCLAW_TEST_READER_ADDED";
        const deletedKey = "OPENCLAW_TEST_READER_DELETED";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [ownedKey]: "candidate" } },
          gateway: { port: "invalid" },
        });
        const env: NodeJS.ProcessEnv = {
          HOME: home,
          [ownedKey]: "lower-precedence",
          [deletedKey]: "previous-owner",
        };
        let reachedBoundary = false;
        let producedValue: string | undefined;
        const io = createConfigIO({
          configPath,
          env,
          lowerPrecedenceEnv: { [ownedKey]: "lower-precedence" },
          observe: false,
          pluginValidation: "skip",
          measure: async (name, run) => {
            const result = await run();
            if (name === "config.snapshot.read.legacy-issues") {
              reachedBoundary = true;
              producedValue = env[ownedKey];
              env[addedKey] = "new-owner";
              delete env[deletedKey];
              if (change === "replaced") {
                env[ownedKey] = "replacement-owner";
              } else if (change === "deleted") {
                delete env[ownedKey];
              }
            }
            return result;
          },
        });
        const snapshot =
          entry === "for-write"
            ? (await io.readConfigFileSnapshotForWrite()).snapshot
            : await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        expect(reachedBoundary).toBe(true);
        expect(producedValue).toBe("candidate");
        expect(env[ownedKey]).toBe(
          change === "unchanged"
            ? "lower-precedence"
            : change === "replaced"
              ? "replacement-owner"
              : undefined,
        );
        expect(env[addedKey]).toBe("new-owner");
        expect(env[deletedKey]).toBeUndefined();
      });
    },
  );

  it.each(
    (["snapshot", "for-write"] as const).flatMap((entry) =>
      (["unchanged", "replaced", "deleted"] as const).map((change) => ({ entry, change })),
    ),
  )(
    "restores case-distinct custom env properties after invalid $entry (owned=$change)",
    async ({ entry, change }) => {
      await withTempHome(async (home) => {
        const upperKey = "OPENCLAW_TEST_CUSTOM_READER_CASE";
        const mixedKey = "OpenClaw_Test_Custom_Reader_Case";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [upperKey]: "candidate" } },
          gateway: { port: "invalid" },
        });
        const env: NodeJS.ProcessEnv = { HOME: home, [mixedKey]: "other-property" };
        let producedValues: Array<string | undefined> = [];
        const io = createConfigIO({
          configPath,
          env,
          observe: false,
          pluginValidation: "skip",
          measure: async (name, run) => {
            const result = await run();
            if (name === "config.snapshot.read.legacy-issues") {
              producedValues = [env[mixedKey], env[upperKey]];
              env[mixedKey] = "foreign-property";
              if (change === "replaced") {
                env[upperKey] = "replacement-owner";
              } else if (change === "deleted") {
                delete env[upperKey];
              }
            }
            return result;
          },
        });
        const snapshot =
          entry === "for-write"
            ? (await io.readConfigFileSnapshotForWrite()).snapshot
            : await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        expect(producedValues).toEqual(["other-property", "candidate"]);
        expect(env[mixedKey]).toBe("foreign-property");
        expect(env[upperKey]).toBe(change === "replaced" ? "replacement-owner" : undefined);
        expect(Object.hasOwn(env, upperKey)).toBe(change === "replaced");
      });
    },
  );

  it.each(["snapshot", "for-write"] as const)(
    "preserves both custom env property spellings after valid %s",
    async (entry) => {
      await withTempHome(async (home) => {
        const upperKey = "OPENCLAW_TEST_VALID_READER_CASE";
        const mixedKey = "OpenClaw_Test_Valid_Reader_Case";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [upperKey]: "candidate" } },
          gateway: { mode: "local" },
        });
        const env: NodeJS.ProcessEnv = { HOME: home, [mixedKey]: "other-property" };
        const io = createConfigIO({
          configPath,
          env,
          observe: false,
          pluginValidation: "skip",
        });
        const snapshot =
          entry === "for-write"
            ? (await io.readConfigFileSnapshotForWrite()).snapshot
            : await io.readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(env[mixedKey]).toBe("other-property");
        expect(env[upperKey]).toBe("candidate");
        expect(Object.hasOwn(env, mixedKey)).toBe(true);
        expect(Object.hasOwn(env, upperKey)).toBe(true);
      });
    },
  );

  it("restores normalized aliases without overwriting a newer canonical value", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { Z_AI_API_KEY: "candidate" } },
        gateway: { port: "invalid" },
      });
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        Z_AI_API_KEY: "lower-precedence",
        ZAI_API_KEY: "lower-precedence",
      };
      let producedAliases: Array<string | undefined> = [];
      const io = createConfigIO({
        configPath,
        env,
        lowerPrecedenceEnv: {
          Z_AI_API_KEY: "lower-precedence",
          ZAI_API_KEY: "lower-precedence",
        },
        observe: false,
        pluginValidation: "skip",
        measure: async (name, run) => {
          const result = await run();
          if (name === "config.snapshot.read.legacy-issues") {
            producedAliases = [env.Z_AI_API_KEY, env.ZAI_API_KEY];
            env.ZAI_API_KEY = "replacement-owner";
          }
          return result;
        },
      });
      await expect(io.readConfigFileSnapshot()).resolves.toMatchObject({ valid: false });
      expect(producedAliases).toEqual(["candidate", "candidate"]);
      expect(env.Z_AI_API_KEY).toBe("lower-precedence");
      expect(env.ZAI_API_KEY).toBe("replacement-owner");
    });
  });

  (process.platform === "win32" ? it : it.skip).each(
    (["plain", "cloned"] as const).flatMap((environment) =>
      (["unchanged", "replaced", "deleted", "renamed"] as const).map((change) => ({
        environment,
        change,
      })),
    ),
  )(
    "restores $environment env casing after invalid validation ($change)",
    async ({ environment, change }) => {
      const { cloneEnvWithPlatformSemantics } = await import("./config-env-vars.js");
      await withTempHome(async (home) => {
        const upperKey = "OPENCLAW_TEST_CLONED_READER_CASE";
        const originalKey = "OpenClaw_Test_Cloned_Reader_Case";
        const renamedKey = "openclaw_test_cloned_reader_case";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [upperKey]: "candidate" } },
          gateway: { port: "invalid" },
        });
        const originalEnv: NodeJS.ProcessEnv = {
          HOME: home,
          [originalKey]: "lower-precedence",
        };
        const env =
          environment === "cloned" ? cloneEnvWithPlatformSemantics(originalEnv) : originalEnv;
        expect(Object.hasOwn(env, upperKey)).toBe(environment === "cloned");
        let producedKey: string | undefined;
        let producedValue: string | undefined;
        const io = createConfigIO({
          configPath,
          env,
          lowerPrecedenceEnv: { [originalKey]: "lower-precedence" },
          observe: false,
          pluginValidation: "skip",
          measure: async (name, run) => {
            const result = await run();
            if (name === "config.snapshot.read.legacy-issues") {
              producedKey = Object.keys(env).find((key) => key.toUpperCase() === upperKey);
              producedValue = env[upperKey];
              if (change === "replaced") {
                env[upperKey] = "replacement-owner";
              } else if (change === "deleted" || change === "renamed") {
                delete env[upperKey];
                if (change === "renamed") {
                  env[renamedKey] = "candidate";
                }
              }
            }
            return result;
          },
        });
        await expect(io.readConfigFileSnapshot()).resolves.toMatchObject({ valid: false });
        expect(producedKey).toBe(upperKey);
        expect(producedValue).toBe("candidate");
        const expectedProperties: Record<string, string> = {};
        if (environment === "plain" || change === "unchanged") {
          expectedProperties[originalKey] = "lower-precedence";
        }
        if (change === "replaced") {
          expectedProperties[upperKey] = "replacement-owner";
        } else if (change === "renamed") {
          expectedProperties[renamedKey] = "candidate";
        }
        expect(
          Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() === upperKey)),
        ).toEqual(expectedProperties);
      });
    },
  );

  (process.platform === "win32" ? it : it.skip).each([
    "unchanged",
    "replaced",
    "deleted",
    "renamed",
  ] as const)(
    "restores the original Windows process.env key spelling after invalid validation (%s)",
    async (change) => {
      await withTempHome(async (home) => {
        const upperKey = "OPENCLAW_TEST_READER_CASE";
        const originalKey = "OpenClaw_Test_Reader_Case";
        const renamedKey = "openclaw_test_reader_case";
        const configPath = await writeOpenClawConfig(home, {
          env: { vars: { [upperKey]: "candidate" } },
          gateway: { port: "invalid" },
        });
        await withEnvAsync({ [upperKey]: undefined }, async () => {
          process.env[originalKey] = "lower-precedence";
          const beforeKey = Object.keys(process.env).find((key) => key.toUpperCase() === upperKey);
          let producedKey: string | undefined;
          let producedValue: string | undefined;
          const io = createConfigIO({
            configPath,
            env: process.env,
            lowerPrecedenceEnv: { [originalKey]: "lower-precedence" },
            observe: false,
            pluginValidation: "skip",
            measure: async (name, run) => {
              const result = await run();
              if (name === "config.snapshot.read.legacy-issues") {
                producedKey = Object.keys(process.env).find(
                  (key) => key.toUpperCase() === upperKey,
                );
                producedValue = process.env[upperKey];
                if (change === "replaced") {
                  process.env[upperKey] = "replacement-owner";
                } else if (change === "deleted" || change === "renamed") {
                  delete process.env[upperKey];
                  if (change === "renamed") {
                    process.env[renamedKey] = "candidate";
                  }
                }
              }
              return result;
            },
          });
          await expect(io.readConfigFileSnapshot()).resolves.toMatchObject({ valid: false });
          expect(beforeKey).toBe(originalKey);
          expect(producedKey).toBe(upperKey);
          expect(producedValue).toBe("candidate");
          const expectedKey =
            change === "unchanged"
              ? originalKey
              : change === "replaced"
                ? upperKey
                : change === "renamed"
                  ? renamedKey
                  : undefined;
          expect(Object.keys(process.env).filter((key) => key.toUpperCase() === upperKey)).toEqual(
            expectedKey ? [expectedKey] : [],
          );
          expect(process.env[upperKey]).toBe(
            change === "unchanged"
              ? "lower-precedence"
              : change === "replaced"
                ? "replacement-owner"
                : change === "renamed"
                  ? "candidate"
                  : undefined,
          );
        });
      });
    },
  );

  it("restores an overwritten env var after invalid snapshot validation", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        env: { vars: { PRE_EXISTING: "new-value" } },
        gateway: { port: "invalid" },
      });

      const env = {
        HOME: home,
        PRE_EXISTING: "original-value",
      } as NodeJS.ProcessEnv;
      const io = createConfigIO({
        env,
        homedir: () => home,
        logger: { warn: () => {}, error: () => {} },
      });

      const snapshot = await io.readConfigFileSnapshot();

      expect(snapshot.valid).toBe(false);
      expect(env.PRE_EXISTING).toBe("original-value");
    });
  });
});

describe("snapshot env change receipts", () => {
  it("consumes an invalid snapshot's env receipt before an outer compensation can reuse it", async () => {
    const { withConfigReadEnvChanges } = await import("./config-env-vars.js");
    await withTempHome(async (home) => {
      const envKey = "OPENCLAW_TEST_READER_RECEIPT";
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { [envKey]: "candidate" } },
        gateway: { port: "invalid" },
      });
      const env: NodeJS.ProcessEnv = { HOME: home };
      const io = createConfigIO({
        configPath,
        env,
        observe: false,
        pluginValidation: "skip",
      });
      let restore: (() => void) | undefined;
      const snapshot = await withConfigReadEnvChanges(env, async (restoreChanges) => {
        restore = restoreChanges;
        return await io.readConfigFileSnapshot();
      });
      expect(snapshot.valid).toBe(false);
      expect(env[envKey]).toBeUndefined();
      expect(restore).toBeDefined();
      env[envKey] = "candidate";
      restore!();
      restore!();
      expect(env[envKey]).toBe("candidate");
    });
  });

  it("keeps a later descendant read outside the settled receipt scope", async () => {
    const { withConfigReadEnvChanges } = await import("./config-env-vars.js");
    await withTempHome(async (home) => {
      const firstKey = "OPENCLAW_TEST_READER_FIRST";
      const laterKey = "OPENCLAW_TEST_READER_LATER";
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { [firstKey]: "first" } },
        gateway: { mode: "local" },
      });
      const env: NodeJS.ProcessEnv = { HOME: home };
      let releaseLaterRead = () => {};
      const laterReadReady = new Promise<void>((resolve) => {
        releaseLaterRead = resolve;
      });
      let laterRead:
        | ReturnType<ReturnType<typeof createConfigIO>["readConfigFileSnapshot"]>
        | undefined;
      const io = createConfigIO({
        configPath,
        env,
        observe: false,
        pluginValidation: "skip",
        measure: async (name, run) => {
          if (name === "config.snapshot.read.file" && !laterRead) {
            laterRead = laterReadReady.then(() => io.readConfigFileSnapshot());
          }
          return await run();
        },
      });
      let restore: (() => void) | undefined;
      try {
        const snapshot = await withConfigReadEnvChanges(env, async (restoreChanges) => {
          restore = restoreChanges;
          return await io.readConfigFileSnapshot();
        });
        expect(snapshot.valid).toBe(true);
        expect(env[firstKey]).toBe("first");
        expect(laterRead).toBeDefined();
        await writeOpenClawConfig(home, {
          env: { vars: { [laterKey]: "later-owner" } },
          gateway: { mode: "local" },
        });
        releaseLaterRead();
        await expect(laterRead).resolves.toMatchObject({ valid: true });
        expect(env[laterKey]).toBe("later-owner");
        expect(restore).toBeDefined();
        restore!();
        expect(env[firstKey]).toBeUndefined();
        expect(env[laterKey]).toBe("later-owner");
      } finally {
        releaseLaterRead();
        await laterRead;
      }
    });
  });

  it("does not collect a real reader's writes to a different environment", async () => {
    const { withConfigReadEnvChanges } = await import("./config-env-vars.js");
    await withTempHome(async (home) => {
      const envKey = "OPENCLAW_TEST_READER_OTHER_ENV";
      const configPath = await writeOpenClawConfig(home, {
        env: { vars: { [envKey]: "reader-value" } },
        gateway: { mode: "local" },
      });
      const env: NodeJS.ProcessEnv = { HOME: home };
      const otherEnv: NodeJS.ProcessEnv = { HOME: home };
      const io = createConfigIO({
        configPath,
        env: otherEnv,
        observe: false,
        pluginValidation: "skip",
      });
      let restore: (() => void) | undefined;
      await withConfigReadEnvChanges(env, async (restoreChanges) => {
        restore = restoreChanges;
        await expect(io.readConfigFileSnapshot()).resolves.toMatchObject({ valid: true });
      });
      expect(restore).toBeDefined();
      restore!();
      expect(env[envKey]).toBeUndefined();
      expect(otherEnv[envKey]).toBe("reader-value");
    });
  });
});
