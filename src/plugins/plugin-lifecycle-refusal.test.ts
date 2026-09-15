import { describe, expect, it } from "vitest";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "./plugin-lifecycle-lease.js";

describe("shared plugin lifecycle authority refusal", () => {
  it.each([
    { label: "Error", failure: new Error("one-shot caller refusal") },
    { label: "false", failure: false },
    { label: "undefined", failure: undefined },
  ])(
    "keeps the first nested caller refusal scoped to its captured lease ($label)",
    async ({ failure }) => {
      await withOpenClawTestState({ label: "shared-plugin-refusal" }, async (state) => {
        const refuse = () => {
          // oxlint-disable-next-line typescript/only-throw-error -- Preserve actual JavaScript refusal values, including undefined.
          throw failure;
        };
        const assertInTransaction = (lease: PluginLifecycleLeaseContext) =>
          runOpenClawStateWriteTransaction(({ db }) => lease.assertOwnedInTransaction(db), {
            env: state.env,
          });
        const writeRecords = (lease: PluginLifecycleLeaseContext, spec: string) =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            { demo: { source: "npm", spec } },
            { env: state.env, candidates: [], lease },
          );
        await withPluginLifecycleLease({ env: state.env }, async (outer) => {
          let entered = false;
          await expect(
            withPluginLifecycleLease({ assertCurrent: refuse }, async () => {
              entered = true;
            }),
          ).rejects.toBe(failure);
          expect(entered).toBe(false);
          expect(() => outer.assertOwned()).not.toThrow();
          expect(() => assertInTransaction(outer)).not.toThrow();

          for (const firstAssertion of ["outside", "transaction"] as const) {
            let current = true;
            let checks = 0;
            const assertCurrent = () => {
              checks++;
              if (!current) {
                refuse();
              }
            };
            const captured = await withPluginLifecycleLease({ assertCurrent }, async (inner) => {
              expect(inner).not.toBe(outer);
              await withPluginLifecycleLease({}, async (nested) => {
                expect(nested).toBe(inner);
                nested.assertOwned();
                assertInTransaction(nested);
              });
              return inner;
            });
            const before = await readPersistedInstalledPluginIndex({ env: state.env });
            current = false;
            await expect(
              Promise.resolve().then(() =>
                firstAssertion === "outside"
                  ? captured.assertOwned()
                  : assertInTransaction(captured),
              ),
            ).rejects.toBe(failure);
            current = true;
            const checksAtRefusal = checks;
            await expect(Promise.resolve().then(() => captured.assertOwned())).rejects.toBe(
              failure,
            );
            await expect(Promise.resolve().then(() => assertInTransaction(captured))).rejects.toBe(
              failure,
            );
            await expect(writeRecords(captured, "demo@2.0.0")).rejects.toBe(failure);
            expect(checks).toBe(checksAtRefusal);
            expect(await readPersistedInstalledPluginIndex({ env: state.env })).toEqual(before);

            // The caller owns this refusal. Its parent and a fresh sibling still
            // hold the database lease and can persist their own metadata.
            outer.assertOwned();
            assertInTransaction(outer);
            await writeRecords(outer, "demo@1.0.0");
            await withPluginLifecycleLease({ assertCurrent }, async (fresh) => {
              expect(fresh).not.toBe(captured);
              await writeRecords(fresh, "demo@3.0.0");
              await expect(Promise.resolve().then(() => captured.assertOwned())).rejects.toBe(
                failure,
              );
            });
            expect(
              (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords.demo
                ?.spec,
            ).toBe("demo@3.0.0");
          }
        });
        await withPluginLifecycleLease({ env: state.env }, async (fresh) => {
          fresh.assertOwned();
          await writeRecords(fresh, "demo@4.0.0");
        });
        expect(
          (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords.demo?.spec,
        ).toBe("demo@4.0.0");
      });
    },
  );

  it("does not turn an ordinary nested operation error into authority refusal", async () => {
    await withOpenClawTestState({ label: "plugin-operation-error" }, async (state) => {
      const failure = new Error("download failed");
      await withPluginLifecycleLease({ env: state.env }, async (outer) => {
        await expect(
          withPluginLifecycleLease({}, async () => {
            throw failure;
          }),
        ).rejects.toBe(failure);
        outer.assertOwned();
        await withPluginLifecycleLease({}, async (inner) => {
          expect(inner).toBe(outer);
          inner.assertOwned();
        });
      });
    });
  });
});
