import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as backupRotation from "../../config/backup-rotation.js";
import {
  getPublishedConfigRuntimeEnvState,
  initializePublishedConfigRuntimeEnv,
} from "../../config/config-env-vars.js";
import { readConfigHealthStateFromStore } from "../../config/io.health-state.js";
import { createConfigIO } from "../../config/io.js";
import { replaceConfigFile } from "../../config/mutate.js";
import {
  getRuntimeConfigSnapshot,
  registerManagedRuntimeConfigWriteOwner,
  registerRuntimeConfigWriteListener,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../../config/runtime-snapshot.js";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  captureFiles,
  useConfigWriterFixture,
} from "./update-command-config-fence.test-support.js";

const withConfigWriter = useConfigWriterFixture();

it.each(
  (["disposal", "reread", "refresh"] as const).flatMap((boundary) =>
    [false, true].map((revoked) => ({ boundary, revoked })),
  ),
)(
  "retains include authority through $boundary (revoked=$revoked)",
  async ({ boundary, revoked }) => {
    await withConfigWriter(true, async (fixture) => {
      const envKey = "OPENCLAW_TEST_INCLUDE_OWNER_ENV";
      fixture.env[envKey] = "before";
      const healthOptions = {
        env: fixture.env,
        homedir: () => fixture.home,
        logger: { warn: () => {} },
      };
      const beforeHealth = readConfigHealthStateFromStore(healthOptions);
      let reachedBoundary = false;
      const atBoundary = () => {
        reachedBoundary = true;
        if (revoked) {
          fixture.revoke();
        }
      };
      if (boundary === "disposal") {
        const prepare = backupRotation.prepareConfigFileWrite;
        vi.spyOn(backupRotation, "prepareConfigFileWrite").mockImplementationOnce(
          async (params) => {
            const prepared = await prepare(params);
            return {
              ...prepared,
              async [Symbol.asyncDispose]() {
                await prepared[Symbol.asyncDispose]();
                atBoundary();
              },
            };
          },
        );
      } else {
        const snapshot = await fixture.io.readConfigFileSnapshot({ observe: false });
        setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
      }
      if (boundary === "reread") {
        const observingIO = createConfigIO({
          configPath: fixture.configPath,
          env: fixture.env,
          observe: true,
          pluginValidation: "skip",
        });
        let reads = 0;
        vi.spyOn(fixture.io, "readConfigFileSnapshotForWrite").mockImplementation(
          async (options) => {
            const result = await observingIO.readConfigFileSnapshotForWrite(options);
            if (++reads === 2) {
              fixture.env[envKey] = "after-read";
              atBoundary();
            }
            return result;
          },
        );
      }
      if (boundary === "refresh") {
        setRuntimeConfigSnapshotRefreshHandler({
          refresh: async () => {
            await Promise.resolve();
            atBoundary();
            return false;
          },
        });
      }
      const listener = vi.fn();
      const unregister = registerRuntimeConfigWriteListener(listener);
      try {
        const mutation = fixture.write({
          assertCurrent: fixture.assertCurrent,
          ...(boundary === "disposal" ? { skipRuntimeSnapshotRefresh: true } : {}),
        });
        if (revoked) {
          await expect(mutation).rejects.toMatchObject({
            name: "ConfigWritePostCommitError",
            rollbackStatus: "unknown",
          });
        } else {
          await mutation;
        }
      } finally {
        unregister();
      }
      expect(reachedBoundary).toBe(true);
      expect(JSON.parse(await fs.readFile(fixture.includePath, "utf8")).port).toBe(18791);
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.original);
      expect(getRuntimeConfigSnapshot()?.gateway?.port).toBe(
        boundary === "disposal" ? undefined : revoked ? 18789 : 18791,
      );
      expect(listener).toHaveBeenCalledTimes(revoked || boundary === "disposal" ? 0 : 1);
      expect(fixture.env[envKey]).toBe(boundary === "reread" ? "after-read" : "before");
      expect(readConfigHealthStateFromStore(healthOptions)).toEqual(beforeHealth);
    });
  },
);

it.each(
  (["env", "invalid-restore"] as const).flatMap((boundary) =>
    (["explicit", "ambient"] as const).flatMap((authority) =>
      [false, true].map((revoked) => ({ boundary, authority, revoked })),
    ),
  ),
)(
  "fences an env-owned include at $boundary with $authority authority (revoked=$revoked)",
  async ({ boundary, authority, revoked }) => {
    await withConfigWriter(true, async (fixture) => {
      const envKey = "OPENCLAW_TEST_GUARDED_INCLUDE_ENV";
      delete fixture.env[envKey];
      const rootConfig = {
        gateway: { mode: "local", port: 18789 },
        env: { $include: "./includes/gateway.json" },
      };
      const rootRaw = `${JSON.stringify(rootConfig)}\n`;
      const invalidRootRaw = `${JSON.stringify({
        ...rootConfig,
        gateway: { mode: "local", port: "invalid" },
      })}\n`;
      const includeRaw = '{"vars":{}}\n';
      await fs.writeFile(fixture.configPath, rootRaw);
      await fs.writeFile(fixture.includePath, includeRaw);
      const rootBackups = captureFiles(fixture.publicPaths.slice(1, 6));
      const refusals: unknown[] = [];
      const readFailures: unknown[] = [];
      const assertCurrent = () => {
        try {
          fixture.assertCurrent();
        } catch (error) {
          refusals.push(error);
          throw error;
        }
      };
      let reads = 0;
      let reachedBoundary = false;
      const io = createConfigIO({
        env: fixture.env,
        observe: false,
        pluginValidation: "skip",
        measure: async (name, run) => {
          if (name === "config.snapshot.read.file") {
            reads += 1;
            if (reads === 2 && boundary === "invalid-restore") {
              await fs.writeFile(fixture.configPath, invalidRootRaw);
            }
          }
          if (reads === 2 && name === "config.snapshot.read.env" && boundary === "env") {
            await Promise.resolve();
            reachedBoundary = true;
            if (revoked) {
              fixture.revoke();
            }
            try {
              return await run();
            } catch (error) {
              throw new Error("measurement replaced the authority refusal", { cause: error });
            }
          }
          const result = await run();
          if (
            reads === 2 &&
            name === "config.snapshot.read.legacy-issues" &&
            boundary === "invalid-restore"
          ) {
            reachedBoundary = true;
            if (revoked) {
              fixture.env[envKey] = "replacement-owner";
              fixture.revoke();
            }
          }
          return result;
        },
      });
      const read = io.readConfigFileSnapshotForWrite;
      vi.spyOn(io, "readConfigFileSnapshotForWrite").mockImplementation(async (options) => {
        try {
          return await read(options);
        } catch (error) {
          readFailures.push(error);
          throw error;
        }
      });
      const prepared = await io.readConfigFileSnapshotForWrite();
      const write = () =>
        replaceConfigFile({
          io,
          snapshot: prepared.snapshot,
          baseHash: prepared.snapshot.hash,
          nextConfig: {
            ...prepared.snapshot.sourceConfig,
            env: { vars: { [envKey]: "candidate" } },
          },
          writeOptions: {
            ...prepared.writeOptions,
            skipPluginValidation: true,
            ...(authority === "explicit" ? { assertCurrent } : {}),
          },
        });
      const mutation =
        authority === "ambient"
          ? withConfigWriteLock(fixture.configPath, write, fixture.env, assertCurrent)
          : write();
      const error = await mutation.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(reachedBoundary).toBe(true);
      expect(reads).toBe(2);
      if (revoked) {
        expect(refusals[0]).toBeInstanceOf(Error);
        expect(readFailures).toHaveLength(1);
        expect(readFailures[0]).toBe(refusals[0]);
        expect(error).toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "unknown",
          cause: { errors: [refusals[0], expect.any(Error)] },
        });
      } else if (boundary === "invalid-restore") {
        expect(error).toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
        });
        expect(readFailures).toEqual([]);
      } else {
        expect(error).toBeUndefined();
        fixture.assertCurrent();
      }
      expect(fixture.env[envKey]).toBe(
        boundary === "invalid-restore"
          ? revoked
            ? "replacement-owner"
            : undefined
          : revoked
            ? undefined
            : "candidate",
      );
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(
        boundary === "invalid-restore" ? invalidRootRaw : rootRaw,
      );
      expect(JSON.parse(await fs.readFile(fixture.includePath, "utf8"))).toEqual(
        boundary === "invalid-restore" && !revoked
          ? { vars: {} }
          : { vars: { [envKey]: "candidate" } },
      );
      expect(captureFiles(fixture.publicPaths.slice(1, 6))).toEqual(rootBackups);
    });
  },
);

it.each(
  (["file", "env"] as const).flatMap((boundary) =>
    (["explicit", "ambient"] as const).map((authority) => ({ boundary, authority })),
  ),
)(
  "preserves foreign env changes during the include $boundary await with $authority authority",
  async ({ boundary, authority }) => {
    await withConfigWriter(true, async (fixture) => {
      const ownedKey = "OPENCLAW_TEST_INCLUDE_OWNED";
      const replacedKey = "OPENCLAW_TEST_INCLUDE_REPLACED";
      const addedKey = "OPENCLAW_TEST_INCLUDE_ADDED";
      const deletedKey = "OPENCLAW_TEST_INCLUDE_DELETED";
      delete fixture.env[ownedKey];
      delete fixture.env[replacedKey];
      delete fixture.env[addedKey];
      fixture.env[deletedKey] = "previous-owner";
      const rootRaw = `${JSON.stringify({
        gateway: { mode: "local", port: 18789 },
        env: { $include: "./includes/gateway.json" },
      })}\n`;
      const includeRaw = '{"vars":{}}\n';
      await fs.writeFile(fixture.configPath, rootRaw);
      await fs.writeFile(fixture.includePath, includeRaw);
      const rootBackups = captureFiles(fixture.publicPaths.slice(1, 6));
      const otherPath = path.join(fixture.home, "new-selection.json");
      let reads = 0;
      let reachedBoundary = false;
      let ownedAtBoundary: string | undefined;
      const io = createConfigIO({
        env: fixture.env,
        observe: false,
        pluginValidation: "skip",
        measure: async (name, run) => {
          if (name === "config.snapshot.read.file") {
            reads += 1;
          }
          const result = await run();
          if (reads === 2 && name === `config.snapshot.read.${boundary}`) {
            reachedBoundary = true;
            ownedAtBoundary = fixture.env[ownedKey];
            fixture.env.OPENCLAW_CONFIG_PATH = otherPath;
            fixture.env[replacedKey] = "replacement-owner";
            fixture.env[addedKey] = "new-owner";
            delete fixture.env[deletedKey];
          }
          return result;
        },
      });
      const prepared = await io.readConfigFileSnapshotForWrite();
      const failures: unknown[] = [];
      const read = io.readConfigFileSnapshotForWrite;
      vi.spyOn(io, "readConfigFileSnapshotForWrite").mockImplementation(async (options) => {
        try {
          return await read(options);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      });
      const listener = vi.fn();
      const unregister = registerRuntimeConfigWriteListener(listener);
      const write = () =>
        replaceConfigFile({
          io,
          snapshot: prepared.snapshot,
          baseHash: prepared.snapshot.hash,
          nextConfig: {
            ...prepared.snapshot.sourceConfig,
            env: { vars: { [ownedKey]: "candidate", [replacedKey]: "candidate" } },
          },
          writeOptions: {
            ...prepared.writeOptions,
            skipPluginValidation: true,
            ...(authority === "explicit" ? { assertCurrent: fixture.assertCurrent } : {}),
          },
        });
      try {
        const operation =
          authority === "ambient"
            ? withConfigWriteLock(fixture.configPath, write, fixture.env, fixture.assertCurrent)
            : write();
        const error = await operation.then(
          () => undefined,
          (failure: unknown) => failure,
        );
        expect(failures).toHaveLength(1);
        expect(error).toMatchObject({
          name: "ConfigWritePostCommitError",
          rollbackStatus: "restored",
          cause: failures[0],
        });
        expect((error as Error).cause).toBe(failures[0]);
      } finally {
        unregister();
      }
      expect(reachedBoundary).toBe(true);
      expect(reads).toBe(2);
      expect(ownedAtBoundary).toBe(boundary === "env" ? "candidate" : undefined);
      expect(fixture.env[ownedKey]).toBeUndefined();
      expect(fixture.env[replacedKey]).toBe("replacement-owner");
      expect(fixture.env[addedKey]).toBe("new-owner");
      expect(fixture.env[deletedKey]).toBeUndefined();
      expect(fixture.env.OPENCLAW_CONFIG_PATH).toBe(otherPath);
      expect(await fs.readFile(fixture.includePath, "utf8")).toBe(includeRaw);
      expect(await fs.readFile(`${fixture.includePath}.bak`, "utf8")).toBe(includeRaw);
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(rootRaw);
      expect(captureFiles(fixture.publicPaths.slice(1, 6))).toEqual(rootBackups);
      await expect(fs.stat(otherPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(listener).not.toHaveBeenCalled();
      expect(getRuntimeConfigSnapshot()).toBeNull();
      fixture.assertCurrent();
    });
  },
);

it("retains partial env producer writes for include compensation when the producer throws", async () => {
  await withConfigWriter(true, async (fixture) => {
    const firstKey = "OPENCLAW_TEST_INCLUDE_FIRST_ENV";
    const blockedKey = "OPENCLAW_TEST_INCLUDE_BLOCKED_ENV";
    const foreignKey = "OPENCLAW_TEST_INCLUDE_FOREIGN_ENV";
    delete fixture.env[firstKey];
    delete fixture.env[blockedKey];
    delete fixture.env[foreignKey];
    const producerError = new Error("env producer stopped after its first write");
    let firstWriteObserved = false;
    let refusedWriteObserved = false;
    const env = new Proxy(fixture.env, {
      set(target, key, value) {
        if (key === blockedKey) {
          refusedWriteObserved = true;
          throw producerError;
        }
        if (key === firstKey) {
          firstWriteObserved = true;
        }
        return Reflect.set(target, key, value);
      },
    });
    const rootRaw = `${JSON.stringify({
      gateway: { mode: "local", port: 18789 },
      env: { $include: "./includes/gateway.json" },
    })}\n`;
    const includeRaw = '{"vars":{}}\n';
    await fs.writeFile(fixture.configPath, rootRaw);
    await fs.writeFile(fixture.includePath, includeRaw);
    const rootBackups = captureFiles(fixture.publicPaths.slice(1, 6));
    const producerFailures: unknown[] = [];
    const io = createConfigIO({
      env,
      observe: false,
      pluginValidation: "skip",
      logger: { warn: vi.fn(), error: vi.fn() },
      measure: async (name, run) => {
        try {
          return await run();
        } catch (error) {
          if (name === "config.snapshot.read.env") {
            producerFailures.push(error);
            env[foreignKey] = "new-owner";
          }
          throw error;
        }
      },
    });
    const prepared = await io.readConfigFileSnapshotForWrite();
    await expect(
      replaceConfigFile({
        io,
        snapshot: prepared.snapshot,
        baseHash: prepared.snapshot.hash,
        nextConfig: {
          ...prepared.snapshot.sourceConfig,
          env: { vars: { [firstKey]: "candidate", [blockedKey]: "candidate" } },
        },
        writeOptions: {
          ...prepared.writeOptions,
          skipPluginValidation: true,
          assertCurrent: fixture.assertCurrent,
        },
      }),
    ).rejects.toMatchObject({
      name: "ConfigWritePostCommitError",
      rollbackStatus: "restored",
    });
    expect(firstWriteObserved).toBe(true);
    expect(refusedWriteObserved).toBe(true);
    expect(producerFailures).toEqual([producerError]);
    expect(env[firstKey]).toBeUndefined();
    expect(env[blockedKey]).toBeUndefined();
    expect(env[foreignKey]).toBe("new-owner");
    expect(await fs.readFile(fixture.includePath, "utf8")).toBe(includeRaw);
    expect(await fs.readFile(`${fixture.includePath}.bak`, "utf8")).toBe(includeRaw);
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(rootRaw);
    expect(captureFiles(fixture.publicPaths.slice(1, 6))).toEqual(rootBackups);
    expect(getRuntimeConfigSnapshot()).toBeNull();
    fixture.assertCurrent();
  });
});

it.each([false, true])(
  "compensates only the include reread's dotenv writes (replaced=%s)",
  async (replaced) => {
    await withConfigWriter(true, async (fixture) => {
      const dotenvKey = "OPENCLAW_TEST_INCLUDE_DOTENV";
      const foreignKey = "OPENCLAW_TEST_INCLUDE_DOTENV_FOREIGN";
      await withEnvAsync(
        {
          HOME: fixture.home,
          USERPROFILE: fixture.home,
          OPENCLAW_HOME: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: path.dirname(fixture.configPath),
          OPENCLAW_CONFIG_PATH: fixture.configPath,
          [dotenvKey]: undefined,
          [foreignKey]: undefined,
        },
        async () => {
          const io = createConfigIO({
            env: process.env,
            observe: false,
            pluginValidation: "skip",
          });
          const prepared = await io.readConfigFileSnapshotForWrite();
          const rootBackups = captureFiles(fixture.publicPaths.slice(1, 6));
          await fs.writeFile(
            path.join(path.dirname(fixture.configPath), ".env"),
            `${dotenvKey}=dotenv-value\n`,
          );
          let reachedRefresh = false;
          setRuntimeConfigSnapshotRefreshHandler({
            refresh: async () => {
              await Promise.resolve();
              reachedRefresh = true;
              expect(process.env[dotenvKey]).toBe("dotenv-value");
              process.env[foreignKey] = "new-owner";
              if (replaced) {
                process.env[dotenvKey] = "replacement-owner";
              }
              throw new Error("include refresh rejected");
            },
          });
          await expect(
            replaceConfigFile({
              io,
              snapshot: prepared.snapshot,
              baseHash: prepared.snapshot.hash,
              nextConfig: {
                ...prepared.snapshot.sourceConfig,
                gateway: { ...prepared.snapshot.sourceConfig.gateway, port: 18791 },
              },
              writeOptions: {
                ...prepared.writeOptions,
                skipPluginValidation: true,
                assertCurrent: fixture.assertCurrent,
              },
            }),
          ).rejects.toMatchObject({
            name: "ConfigWritePostCommitError",
            rollbackStatus: "restored",
            message: expect.stringContaining("include refresh rejected"),
          });
          expect(reachedRefresh).toBe(true);
          expect(process.env[dotenvKey]).toBe(replaced ? "replacement-owner" : undefined);
          expect(process.env[foreignKey]).toBe("new-owner");
          expect(await fs.readFile(fixture.includePath, "utf8")).toBe(fixture.includedRaw);
          expect(await fs.readFile(`${fixture.includePath}.bak`, "utf8")).toBe(fixture.includedRaw);
          expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.original);
          expect(captureFiles(fixture.publicPaths.slice(1, 6))).toEqual(rootBackups);
          fixture.assertCurrent();
        },
      );
    });
  },
);

it.each(
  (["disposal", "refresh"] as const).flatMap((boundary) =>
    (["none", "selection", "ancestor"] as const).map((change) => ({ boundary, change })),
  ),
)(
  "retains include selection and path through $boundary ($change)",
  async ({ boundary, change }) => {
    await withConfigWriter(true, async (fixture) => {
      const otherPath = path.join(fixture.home, "unselected.json");
      const includeDir = path.dirname(fixture.includePath);
      const aliasDir = path.join(path.dirname(fixture.configPath), "include-alias");
      const replacementDir = path.join(path.dirname(fixture.configPath), "replacement-includes");
      const replacementRaw = '{"mode":"local","port":19007}\n';
      const replacementPaths = fixture.publicPaths
        .slice(6)
        .map((file) => path.join(replacementDir, path.basename(file)));
      const rootRaw =
        change === "ancestor"
          ? '{"gateway":{"$include":"./include-alias/gateway.json"}}\n'
          : fixture.original;
      if (change === "ancestor") {
        await fs.mkdir(replacementDir);
        await fs.writeFile(replacementPaths[0]!, replacementRaw);
        await fs.symlink(includeDir, aliasDir, "junction");
        await fs.writeFile(fixture.configPath, rootRaw);
      }
      let reachedBoundary = false;
      let retainedFiles: ReturnType<typeof captureFiles> | undefined;
      let replacementFiles: ReturnType<typeof captureFiles> | undefined;
      const atBoundary = async () => {
        reachedBoundary = true;
        if (change === "selection") {
          fixture.env.OPENCLAW_CONFIG_PATH = otherPath;
        } else if (change === "ancestor") {
          // Retarget the authored ancestor without moving the canonical lock.
          await fs.unlink(aliasDir);
          await fs.symlink(replacementDir, aliasDir, "junction");
          retainedFiles = captureFiles(fixture.publicPaths.slice(6));
          replacementFiles = captureFiles(replacementPaths);
        }
      };
      if (boundary === "disposal") {
        const prepare = backupRotation.prepareConfigFileWrite;
        vi.spyOn(backupRotation, "prepareConfigFileWrite").mockImplementationOnce(
          async (params) => {
            const prepared = await prepare(params);
            return {
              ...prepared,
              async [Symbol.asyncDispose]() {
                await prepared[Symbol.asyncDispose]();
                await atBoundary();
              },
            };
          },
        );
      } else {
        const snapshot = await fixture.io.readConfigFileSnapshot({ observe: false });
        setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
        setRuntimeConfigSnapshotRefreshHandler({
          refresh: async () => {
            await Promise.resolve();
            await atBoundary();
            return false;
          },
        });
      }
      const listener = vi.fn();
      const unregister = registerRuntimeConfigWriteListener(listener);
      try {
        const mutation = fixture.write({
          assertCurrent: fixture.assertCurrent,
          ...(boundary === "disposal" ? { skipRuntimeSnapshotRefresh: true } : {}),
        });
        if (change === "none") {
          await mutation;
        } else {
          await expect(mutation).rejects.toMatchObject({
            name: "ConfigWritePostCommitError",
            rollbackStatus: change === "selection" ? "restored" : "unknown",
          });
        }
      } finally {
        unregister();
      }
      expect(reachedBoundary).toBe(true);
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(rootRaw);
      expect(getRuntimeConfigSnapshot()?.gateway?.port).toBe(
        boundary === "disposal" ? undefined : change === "none" ? 18791 : 18789,
      );
      expect(listener).toHaveBeenCalledTimes(change === "none" && boundary === "refresh" ? 1 : 0);
      if (change === "ancestor") {
        expect(captureFiles(fixture.publicPaths.slice(6))).toEqual(retainedFiles);
        expect(captureFiles(replacementPaths)).toEqual(replacementFiles);
        expect(await fs.realpath(aliasDir)).toBe(await fs.realpath(replacementDir));
      } else {
        expect(JSON.parse(await fs.readFile(fixture.includePath, "utf8")).port).toBe(
          change === "selection" ? 18789 : 18791,
        );
      }
      expect(fixture.env.OPENCLAW_CONFIG_PATH).toBe(
        change === "selection" ? otherPath : fixture.configPath,
      );
      await expect(fs.stat(otherPath)).rejects.toMatchObject({ code: "ENOENT" });
      fixture.assertCurrent();
    });
  },
);

it.each([false, true])(
  "retains the managed env generation through include disposal (changed=%s)",
  async (changed) => {
    await withConfigWriter(true, async (fixture) => {
      const initial = { gateway: { mode: "local" as const, port: 18789 } };
      const replacement = { gateway: { mode: "local" as const, port: 19007 } };
      initializePublishedConfigRuntimeEnv(initial);
      const originalGeneration = getPublishedConfigRuntimeEnvState().generation;
      const releaseOwner = registerManagedRuntimeConfigWriteOwner(fixture.configPath);
      let reachedBoundary = false;
      const prepare = backupRotation.prepareConfigFileWrite;
      vi.spyOn(backupRotation, "prepareConfigFileWrite").mockImplementationOnce(async (params) => {
        const prepared = await prepare(params);
        return {
          ...prepared,
          async [Symbol.asyncDispose]() {
            await prepared[Symbol.asyncDispose]();
            reachedBoundary = true;
            if (changed) {
              initializePublishedConfigRuntimeEnv(replacement);
            }
          },
        };
      });
      try {
        const mutation = fixture.write({
          assertCurrent: fixture.assertCurrent,
          skipRuntimeSnapshotRefresh: true,
        });
        if (changed) {
          await expect(mutation).rejects.toMatchObject({
            name: "ConfigWritePostCommitError",
            rollbackStatus: "restored",
          });
        } else {
          await mutation;
        }
      } finally {
        releaseOwner();
      }
      expect(reachedBoundary).toBe(true);
      expect(getRuntimeConfigSnapshot()).toBeNull();
      expect(getPublishedConfigRuntimeEnvState()).toMatchObject({
        generation: originalGeneration + (changed ? 1 : 0),
        sourceConfig: changed ? replacement : initial,
      });
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(fixture.original);
      expect(JSON.parse(await fs.readFile(fixture.includePath, "utf8")).port).toBe(
        changed ? 18789 : 18791,
      );
      fixture.assertCurrent();
    });
  },
);

it.each(["unchanged", "replaced", "deleted", "renamed"] as const)(
  "compensates only the concrete include reader env property (%s)",
  async (change) => {
    await withConfigWriter(true, async (fixture) => {
      const upperKey = "OPENCLAW_TEST_INCLUDE_CASE";
      const mixedKey = "OpenClaw_Test_Include_Case";
      const renamedKey = "openclaw_test_include_case";
      fixture.env[mixedKey] = "other-property";
      fixture.env[upperKey] = "lower-precedence";
      const rootRaw = `${JSON.stringify({
        gateway: { $include: "./includes/gateway.json" },
        env: { vars: { [upperKey]: "candidate" } },
      })}\n`;
      await fs.writeFile(fixture.configPath, rootRaw);
      const prepared = await fixture.io.readConfigFileSnapshotForWrite({ observe: false });
      const rootBackups = captureFiles(fixture.publicPaths.slice(1, 6));
      const io = createConfigIO({
        env: fixture.env,
        lowerPrecedenceEnv: { [upperKey]: "lower-precedence" },
        observe: false,
        pluginValidation: "skip",
      });
      const failure = new Error("include case env refresh rejected");
      let reachedRefresh = false;
      setRuntimeConfigSnapshotRefreshHandler({
        refresh: async () => {
          reachedRefresh = true;
          expect(fixture.env[upperKey]).toBe("candidate");
          expect(fixture.env[mixedKey]).toBe("other-property");
          fixture.env[mixedKey] = "foreign-property";
          if (change === "replaced") {
            fixture.env[upperKey] = "replacement-owner";
          } else if (change === "deleted" || change === "renamed") {
            delete fixture.env[upperKey];
            if (change === "renamed") {
              fixture.env[renamedKey] = "candidate";
            }
          }
          throw failure;
        },
      });
      await expect(
        replaceConfigFile({
          io,
          snapshot: prepared.snapshot,
          baseHash: prepared.snapshot.hash,
          nextConfig: {
            ...prepared.snapshot.sourceConfig,
            gateway: { ...prepared.snapshot.sourceConfig.gateway, port: 18791 },
          },
          writeOptions: {
            ...prepared.writeOptions,
            skipPluginValidation: true,
            assertCurrent: fixture.assertCurrent,
          },
        }),
      ).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        rollbackStatus: "restored",
        cause: expect.objectContaining({ cause: failure }),
      });
      expect(reachedRefresh).toBe(true);
      expect(fixture.env[upperKey]).toBe(
        change === "unchanged"
          ? "lower-precedence"
          : change === "replaced"
            ? "replacement-owner"
            : undefined,
      );
      expect(Object.hasOwn(fixture.env, upperKey)).toBe(
        change === "unchanged" || change === "replaced",
      );
      expect(fixture.env[mixedKey]).toBe("foreign-property");
      expect(fixture.env[renamedKey]).toBe(change === "renamed" ? "candidate" : undefined);
      expect(await fs.readFile(fixture.includePath, "utf8")).toBe(fixture.includedRaw);
      expect(await fs.readFile(`${fixture.includePath}.bak`, "utf8")).toBe(fixture.includedRaw);
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(rootRaw);
      expect(captureFiles(fixture.publicPaths.slice(1, 6))).toEqual(rootBackups);
      fixture.assertCurrent();
    });
  },
);

it.each(["selection", "refresh", "concurrent", "after-restore"] as const)(
  "compensates only the original include with current ownership (%s)",
  async (failure) => {
    await withConfigWriter(true, async (fixture) => {
      const envKey = "OPENCLAW_TEST_INCLUDE_RECOVERY_ENV";
      fixture.env[envKey] = "before";
      const rootRaw = `${JSON.stringify({
        gateway: { $include: "./includes/gateway.json" },
        env: { vars: { [envKey]: "after-read" } },
      })}\n`;
      await fs.writeFile(fixture.configPath, rootRaw);
      const otherPath = path.join(fixture.home, "unselected.json");
      const concurrentRaw = '{"mode":"local","port":19003}\n';
      const prepared = await fixture.io.readConfigFileSnapshotForWrite({ observe: false });
      setRuntimeConfigSnapshot(prepared.snapshot.config, prepared.snapshot.sourceConfig);
      const io = createConfigIO({
        env: fixture.env,
        lowerPrecedenceEnv: { [envKey]: "before" },
        observe: false,
        pluginValidation: "skip",
      });
      const rename = syncFs.renameSync;
      let publications = 0;
      vi.spyOn(syncFs, "renameSync").mockImplementation((source, target) => {
        rename(source, target);
        if (target === fixture.includePath) {
          publications += 1;
          if (failure === "selection" && publications === 1) {
            fixture.env.OPENCLAW_CONFIG_PATH = otherPath;
          }
          if (failure === "after-restore" && publications === 2) {
            fixture.revoke();
          }
        }
      });
      setRuntimeConfigSnapshotRefreshHandler({
        refresh: async () => {
          if (failure === "concurrent") {
            await fs.writeFile(fixture.includePath, concurrentRaw);
          }
          throw new Error("include runtime refresh failed");
        },
      });
      await expect(
        replaceConfigFile({
          io,
          snapshot: prepared.snapshot,
          baseHash: prepared.snapshot.hash,
          nextConfig: {
            ...prepared.snapshot.sourceConfig,
            gateway: { ...prepared.snapshot.sourceConfig.gateway, port: 18791 },
          },
          writeOptions: {
            ...prepared.writeOptions,
            skipPluginValidation: true,
            assertCurrent: fixture.assertCurrent,
          },
        }),
      ).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        rollbackStatus: failure === "concurrent" ? "not-restored" : "restored",
      });
      expect(await fs.readFile(fixture.includePath, "utf8")).toBe(
        failure === "concurrent" ? concurrentRaw : fixture.includedRaw,
      );
      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(rootRaw);
      await expect(fs.stat(otherPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.env[envKey]).toBe(
        failure === "concurrent" || failure === "after-restore" ? "after-read" : "before",
      );
      expect(fixture.env.OPENCLAW_CONFIG_PATH).toBe(
        failure === "selection" ? otherPath : fixture.configPath,
      );
      if (failure !== "after-restore") {
        fixture.assertCurrent();
      }
    });
  },
);
