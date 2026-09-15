import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import {
  createExistingInstallFixture,
  listMatchingDirs,
} from "../infra/install-package-dir.test-support.js";
import * as leaseStore from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  attachPluginInstallTransaction,
  requestDeferredPluginInstall,
  resolvePluginInstallTransactionRequest,
  retainPluginInstallTransaction,
  settlePluginInstallTransactions,
  withPluginInstallTransactions,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexRowSync } from "./installed-plugin-index-row.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "./plugin-lifecycle-lease.js";
import {
  createPluginUpdateTransactionState,
  finalizePluginUpdateSummary,
} from "./update-summary.js";

const repairPeerLinks = vi.hoisted(() => vi.fn());
vi.mock("./update-config.js", () => ({ repairOpenClawPeerLinksForNpmInstalls: repairPeerLinks }));

describe("plugin install transaction ownership", () => {
  it.each(["caller-error", "caller-falsy", "lease-read", "write"] as const)(
    "preserves transaction authority across an index failure: %s",
    async (failureKind) => {
      await withOpenClawTestState({ label: `install-index-${failureKind}` }, async (state) => {
        const { installBaseDir, sourceDir, targetDir } = await createExistingInstallFixture(
          state.root,
        );
        const snapshot = async (directory: string) => {
          const identity = await fs.stat(directory, { bigint: true });
          return {
            dev: identity.dev,
            ino: identity.ino,
            marker: await fs.readFile(path.join(directory, "marker.txt"), "utf8"),
          };
        };
        const original = await snapshot(targetDir);
        const faultError = new Error("index fault");
        const failure = failureKind === "caller-falsy" ? false : faultError;
        let refuseCaller = false;
        let faults = 0;
        const assertCaller = () => {
          if (refuseCaller) {
            refuseCaller = false;
            faults += 1;
            // oxlint-disable-next-line typescript/only-throw-error -- A caller may throw a falsy refusal; it must remain authoritative.
            throw failure;
          }
        };
        const writeRecords = (lease: PluginLifecycleLeaseContext, version: string) =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            { demo: { source: "path", sourcePath: sourceDir, installPath: targetDir, version } },
            { env: state.env, candidates: [], lease },
          );
        const publish = async (owned: object, assertCurrent: () => void) => {
          let backupPath = "";
          const installed = await installPackageDir(
            requestDeferredPackageDirInstall(
              {
                sourceDir,
                targetDir,
                mode: "update" as const,
                timeoutMs: 1_000,
                hasDeps: false,
                copyErrorPrefix: "failed to copy plugin",
                depsLogMessage: "",
                afterBackup: async (directory: string) => {
                  backupPath = directory;
                  return { ok: true as const };
                },
              },
              assertCurrent,
            ),
          );
          expect(installed.ok).toBe(true);
          const transaction = expectDefined(
            resolvePackageDirInstallTransaction(installed),
            "real deferred package transaction",
          );
          retainPluginInstallTransaction(owned, attachPluginInstallTransaction({}, transaction));
          expect(backupPath).not.toBe("");
          return {
            transaction,
            backupPath,
            backup: await snapshot(backupPath),
            published: await snapshot(targetDir),
          };
        };
        let oldLease: PluginLifecycleLeaseContext | undefined;
        let commitDatabase: DatabaseSync | undefined;
        let installed: Awaited<ReturnType<typeof publish>> | undefined;
        let refusal: unknown;
        const assertRefused = async () => {
          const captured = expectDefined(oldLease, "original composed lease");
          const database = expectDefined(commitDatabase, "real index transaction database");
          const publication = expectDefined(installed, "published package and retained backup");
          await expect(Promise.resolve().then(() => captured.assertOwned())).rejects.toBe(refusal);
          await expect(
            Promise.resolve().then(() => captured.assertOwnedInTransaction(database)),
          ).rejects.toBe(refusal);
          await expect(publication.transaction.commit()).rejects.toBe(refusal);
          await expect(publication.transaction.rollback()).rejects.toBe(refusal);
        };

        await withPluginLifecycleLease({ env: state.env }, async (rawLease) => {
          await writeRecords(rawLease, "1.0.0");
          const previousRow = readPersistedInstalledPluginIndexRowSync({ env: state.env });
          expect(previousRow).toBeDefined();
          let failedSql: string | undefined;
          const restoreSpies: (() => void)[] = [];
          let outcome: PromiseSettledResult<unknown>;
          try {
            [outcome] = await Promise.allSettled([
              withPluginLifecycleLease({ assertCurrent: assertCaller }, async (lease) => {
                oldLease = lease;
                return withPluginInstallTransactions(
                  {},
                  () => lease.assertOwned(),
                  async (owned, assertCurrent) => {
                    installed = await publish(owned, assertCurrent);
                    const assertTransaction = lease.assertOwnedInTransaction.bind(lease);
                    let armed = true;
                    const transactionSpy = vi
                      .spyOn(lease, "assertOwnedInTransaction")
                      .mockImplementation((database) => {
                        if (!armed) {
                          assertTransaction(database);
                          return;
                        }
                        armed = false;
                        commitDatabase = database;
                        if (failureKind === "lease-read") {
                          const readSpy = vi
                            .spyOn(leaseStore, "readOpenClawStateLeaseExpiry")
                            .mockImplementationOnce(() => {
                              faults += 1;
                              throw faultError;
                            });
                          restoreSpies.push(() => readSpy.mockRestore());
                        } else if (failureKind !== "write") {
                          refuseCaller = true;
                        }
                        // Arm only at the real index transaction, after package publication.
                        assertTransaction(database);
                        if (failureKind === "write") {
                          const prepareSpy = vi
                            .spyOn(database, "prepare")
                            .mockImplementationOnce((sql) => {
                              failedSql = sql;
                              faults += 1;
                              throw faultError;
                            });
                          restoreSpies.push(() => prepareSpy.mockRestore());
                        }
                      });
                    restoreSpies.push(() => transactionSpy.mockRestore());
                    await writeRecords(lease, "2.0.0");
                  },
                );
              }),
            ]);
          } finally {
            for (const restore of restoreSpies.toReversed()) {
              restore();
            }
          }
          expect(outcome.status).toBe("rejected");
          if (outcome.status !== "rejected") {
            throw new Error("Expected the index fault to reject its install scope");
          }
          refusal = outcome.reason;
          if (failureKind === "lease-read") {
            expect(refusal).toMatchObject({
              code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED",
              cause: failure,
            });
            await expect(Promise.resolve().then(() => rawLease.assertOwned())).rejects.toBe(
              refusal,
            );
          } else {
            expect(refusal).toBe(failure);
            expect(() => rawLease.assertOwned()).not.toThrow();
          }
          expect(faults).toBe(1);
          expect(() => assertCaller()).not.toThrow();
          expect(readPersistedInstalledPluginIndexRowSync({ env: state.env })).toEqual(previousRow);
          const captured = expectDefined(oldLease, "original composed lease");
          const publication = expectDefined(installed, "published package and retained backup");
          if (failureKind === "write") {
            expect(failedSql).toMatch(/^insert into "config_machine_state" /i);
            // The hardlink-rejecting move restores through fresh inodes.
            expect(await fs.readdir(targetDir)).toEqual(["marker.txt"]);
            expect((await snapshot(targetDir)).marker).toBe(original.marker);
            await expect(fs.stat(publication.backupPath)).rejects.toMatchObject({ code: "ENOENT" });
            expect(() => captured.assertOwned()).not.toThrow();
          } else {
            expect(await snapshot(targetDir)).toEqual(publication.published);
            expect(await snapshot(publication.backupPath)).toEqual(publication.backup);
            expect(publication.published.marker).toBe("new");
            expect(publication.backup.marker).toBe("old");
            await assertRefused();
          }
          expect(await listMatchingDirs(installBaseDir, ".openclaw-install-rollback-")).toEqual([]);
        });

        // A newly acquired owner may act after the failed scope releases. Its
        // fresh authority never revives the old lease or retained transaction.
        await withPluginLifecycleLease(
          { env: state.env, assertCurrent: assertCaller },
          async (lease) => {
            await withPluginInstallTransactions(
              {},
              () => lease.assertOwned(),
              async (owned, guard) => {
                await publish(owned, guard);
                await writeRecords(lease, "3.0.0");
              },
            );
          },
        );
        expect(
          (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords.demo
            ?.version,
        ).toBe("3.0.0");
        if (failureKind !== "write") {
          await assertRefused();
        }
      });
    },
  );

  it("keeps synchronous planning callbacks synchronous", async () => {
    const beforePersistentEffect = vi.fn(() => {});
    await withPluginInstallTransactions(
      { beforePersistentEffect },
      () => {},
      async (owned) => {
        expect(owned.beforePersistentEffect()).toBeUndefined();
      },
    );
    expect(beforePersistentEffect).toHaveBeenCalledOnce();
  });

  it("does not compensate earlier installs after an asynchronous planning refusal", async () => {
    const rollback = vi.fn(async () => {});
    const commit = vi.fn(async () => {});
    const beforePersistentEffect = async () => {
      // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may throw falsy values; preserve the original refusal.
      throw false;
    };
    await expect(
      withPluginInstallTransactions(
        { beforePersistentEffect },
        () => {},
        async (owned) => {
          retainPluginInstallTransaction(
            owned,
            attachPluginInstallTransaction({}, { commit, rollback }),
          );
          try {
            await owned.beforePersistentEffect();
          } catch {
            /* Installer failure conversion. */
          }
          return { ok: false };
        },
      ),
    ).rejects.toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("commits direct installs after their operation succeeds", async () => {
    const commit = vi.fn(async () => {});
    const rollback = vi.fn(async () => {});
    await withPluginInstallTransactions(
      {},
      () => {},
      async (owned) => {
        retainPluginInstallTransaction(
          owned,
          attachPluginInstallTransaction({}, { commit, rollback }),
        );
        expect(commit).not.toHaveBeenCalled();
      },
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back admitted installs in reverse order when the operation fails", async () => {
    const settled: string[] = [];
    const failure = new Error("record write failed");
    await expect(
      withPluginInstallTransactions(
        {},
        () => {},
        async (owned) => {
          for (const name of ["first", "second"]) {
            retainPluginInstallTransaction(
              owned,
              attachPluginInstallTransaction(
                {},
                {
                  commit: async () => {
                    settled.push(`commit:${name}`);
                  },
                  rollback: async () => {
                    settled.push(`rollback:${name}`);
                  },
                },
              ),
            );
          }
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(settled).toEqual(["rollback:second", "rollback:first"]);
  });

  it("preserves published state when final cleanup fails after the record commit", async () => {
    const rollback = vi.fn(async () => {});
    const failure = new Error("backup identity changed");
    let recordCommitted = false;
    const commit = vi.fn(async () => {
      expect(recordCommitted).toBe(true);
      throw failure;
    });
    await expect(
      withPluginInstallTransactions(
        {},
        () => {},
        async (owned) => {
          retainPluginInstallTransaction(
            owned,
            attachPluginInstallTransaction({}, { commit, rollback }),
          );
          recordCommitted = true;
        },
      ),
    ).rejects.toMatchObject({ errors: [failure] });
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("leaves deferred settlement with its caller and retains the original assertion", async () => {
    const transactions: PluginInstallTransaction[] = [];
    const refusal = new Error("original owner closed");
    let active = true;
    const params = requestDeferredPluginInstall({}, transactions, () => {
      if (!active) {
        throw refusal;
      }
    });
    const commit = vi.fn(async () => {});
    await withPluginInstallTransactions(
      params,
      () => {},
      async (owned, assertCurrent) => {
        retainPluginInstallTransaction(
          owned,
          attachPluginInstallTransaction(
            {},
            {
              commit: async () => {
                assertCurrent();
                await commit();
              },
              rollback: async () => {
                assertCurrent();
              },
            },
          ),
        );
      },
    );
    expect(transactions).toHaveLength(1);
    expect(commit).not.toHaveBeenCalled();
    active = false;
    const originalRequest = resolvePluginInstallTransactionRequest(params);
    if (!originalRequest) {
      throw new Error("missing original request");
    }
    originalRequest.assertOwned = () => {};
    await expect(transactions[0]!.commit()).rejects.toBe(refusal);
    await expect(transactions[0]!.rollback()).rejects.toBe(refusal);
    expect(commit).not.toHaveBeenCalled();
  });

  it("preserves a commit-time refusal without compensating published packages", async () => {
    const rollback = vi.fn(async () => {});
    let active = true;
    await expect(
      withPluginInstallTransactions(
        {},
        () => {
          if (!active) {
            // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may throw falsy values; preserve the original refusal.
            throw 0;
          }
        },
        async (owned, assertCurrent) => {
          retainPluginInstallTransaction(
            owned,
            attachPluginInstallTransaction(
              {},
              {
                commit: async () => {
                  await Promise.resolve();
                  active = false;
                  assertCurrent();
                },
                rollback,
              },
            ),
          );
        },
      ),
    ).rejects.toBe(0);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("keeps a falsy refusal after an installer converts it into an ordinary result", async () => {
    let active = true;
    await expect(
      withPluginInstallTransactions(
        {},
        () => {
          if (!active) {
            // oxlint-disable-next-line typescript/only-throw-error -- JavaScript callbacks may throw falsy values; preserve the original refusal.
            throw 0;
          }
        },
        async (_owned, assertCurrent) => {
          active = false;
          try {
            assertCurrent();
          } catch {
            /* The installer reports a regular failed result. */
          }
          active = true;
          return { ok: false };
        },
      ),
    ).rejects.toBe(0);
  });
});

describe("plugin install transaction settlement", () => {
  it.each(["commit", "rollback"] as const)(
    "does not replay a successful %s through duplicate or later settlement",
    async (action) => {
      const transaction = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };

      await Promise.all([
        settlePluginInstallTransactions([transaction, transaction], action),
        settlePluginInstallTransactions([transaction], action),
      ]);
      await settlePluginInstallTransactions([transaction], "commit");
      await settlePluginInstallTransactions([transaction], "rollback");

      expect(transaction[action]).toHaveBeenCalledOnce();
      expect(transaction[action === "commit" ? "rollback" : "commit"]).not.toHaveBeenCalled();
    },
  );

  it("retains failed rollback for recovery without replaying settled siblings", async () => {
    const failure = new Error("backup restore failed");
    const settled = { commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
    const pending = {
      commit: vi.fn(async () => {}),
      rollback: vi.fn<() => Promise<void>>().mockRejectedValueOnce(failure).mockResolvedValue(),
    };
    await expect(
      settlePluginInstallTransactions([pending, settled], "rollback"),
    ).rejects.toMatchObject({
      errors: [failure],
    });
    await settlePluginInstallTransactions([pending, settled], "rollback");
    expect(pending.rollback).toHaveBeenCalledTimes(2);
    expect(settled.rollback).toHaveBeenCalledOnce();
  });
});

describe("plugin update finalization", () => {
  it.each([false, true])(
    "preserves the peer-link failure when rollback fails: %s",
    async (rollbackFails) => {
      const root = new Error("Cannot repair OpenClaw peer link: target is not a directory");
      const cleanup = new Error("Cannot restore plugin backup");
      repairPeerLinks.mockRejectedValueOnce(root);
      const rollback = vi.fn(async () => {
        if (rollbackFails) {
          throw cleanup;
        }
      });
      const transactionState = createPluginUpdateTransactionState({});
      transactionState.transactions.push({ commit: vi.fn(), rollback });

      const failure: unknown = await finalizePluginUpdateSummary({
        config: {},
        changed: true,
        outcomes: [],
        ranNpmInstaller: true,
        logger: {},
        transactionState,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(root.message);
      if (rollbackFails) {
        expect(failure).toMatchObject({ cause: root, errors: [root, cleanup] });
      } else {
        expect(failure).toBe(root);
      }
      expect(rollback).toHaveBeenCalledOnce();
    },
  );
});
