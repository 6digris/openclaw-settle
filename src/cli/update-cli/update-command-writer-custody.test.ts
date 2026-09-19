import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginUpdateWriterCustody,
  captureUpdateWriterCustody,
  settleUpdateWriterCustodyForActivation,
  withUpdateWriterCustody,
} from "./update-command-writer-custody.js";

function peer(code: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "-e", code, ...args],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  ).trim();
}
const coordinatorModule = new URL("../../infra/sqlite-coordinator.ts", import.meta.url).href;
const custodyModule = new URL("./update-command-writer-custody.ts", import.meta.url).href;
const configModule = new URL("../../config/write-lock.ts", import.meta.url).href;
const lifecycleModule = new URL("../../infra/state-database-coordinator.ts", import.meta.url).href;
const contender = `
import { tryAcquireExclusiveSqliteCoordinator } from ${JSON.stringify(coordinatorModule)};
const results = process.argv.slice(1).map(path => {
  const owner = tryAcquireExclusiveSqliteCoordinator(path);
  const admitted = !!owner;
  owner?.release();
  return admitted;
});
process.stdout.write(JSON.stringify(results));
`;

it("keeps native writer exclusion continuously across a fresh migration child", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    let coordinators: string[] = [];
    await withUpdateWriterCustody(
      () => {},
      async () => {
        await beginUpdateWriterCustody(state.env);
        const grant = captureUpdateWriterCustody()!;
        coordinators = grant.coordinators.map((pin) => pin.path);
        expect(JSON.parse(peer(contender, coordinators))).toEqual([false, false]);
        const child = peer(
          `
import { withUpdateWriterCustody } from ${JSON.stringify(custodyModule)};
import { acquireStateDatabaseCoordinator, acquireGatewayMaintenanceCoordinator } from ${JSON.stringify(lifecycleModule)};
import { withConfigWriteLock } from ${JSON.stringify(configModule)};
import fs from 'node:fs/promises';
const grant = JSON.parse(process.argv[1]);
await withUpdateWriterCustody(() => {}, async () => {
  const state = acquireStateDatabaseCoordinator({databasePath: grant.databasePath});
  const gateway = acquireGatewayMaintenanceCoordinator({databasePath: grant.databasePath});
  try {
    await withConfigWriteLock(process.argv[2], () => withConfigWriteLock(process.argv[2], async () => {
      await fs.writeFile(process.argv[3], 'migration-child');
    }));
    process.stdout.write('migrated');
  } finally { gateway.release(); state.release(); }
}, grant);
`,
          [JSON.stringify(grant), state.configPath, state.path("mutation")],
        );
        expect(child).toBe("migrated");
        expect(await fs.readFile(state.path("mutation"), "utf8")).toBe("migration-child");
        // The child settled, but the original executor still fences the next Doctor.
        expect(JSON.parse(peer(contender, coordinators))).toEqual([false, false]);
        await settleUpdateWriterCustodyForActivation();
        expect(JSON.parse(peer(contender, coordinators))).toEqual([true, true]);
      },
    );
    expect(JSON.parse(peer(contender, coordinators))).toEqual([true, true]);
  });
});

it("refuses transferred config writes and child grants after executor revocation", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    let revoked = false;
    await withUpdateWriterCustody(
      () => {
        if (revoked) {
          throw new Error("executor revoked");
        }
      },
      async () => {
        await beginUpdateWriterCustody(state.env);
        revoked = true;
        await expect(
          withConfigWriteLock(state.configPath, async () => {
            throw new Error("effect must not run");
          }),
        ).rejects.toThrow("executor revoked");
        expect(() => captureUpdateWriterCustody()).toThrow("executor revoked");
      },
    );
  });
});

it("hands native custody back over the real spawned child's private control channel", async () => {
  const { runUtf8CommandWithTimeout } = await import("../../process/exec.js");
  const { createUpdateWriterCustodyControl } = await import("./update-command-writer-custody.js");
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    await withUpdateWriterCustody(
      () => {},
      async () => {
        await beginUpdateWriterCustody(state.env);
        const grant = captureUpdateWriterCustody()!;
        grant.activationChannel = { runId: "synthetic-activation" };
        const child = await runUtf8CommandWithTimeout(
          [
            process.execPath,
            "--import",
            path.resolve("scripts/tsx.mjs"),
            "--input-type=module",
            "-e",
            `
        import { withUpdateWriterCustody, settleUpdateWriterCustodyForActivation } from ${JSON.stringify(custodyModule)};
        let input='';for await(const part of process.stdin) input+=part;
        await withUpdateWriterCustody(()=>{},async()=>{
          await settleUpdateWriterCustodyForActivation();
          process.stdout.write('activation-admitted');
        },JSON.parse(input));
        process.disconnect();
      `,
          ],
          {
            input: JSON.stringify(grant),
            onChildMessage: createUpdateWriterCustodyControl("synthetic-activation"),
            timeoutMs: 30_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
        expect(child).toMatchObject({ code: 0, cleanup: "normal", stdout: "activation-admitted" });
        expect(
          JSON.parse(
            peer(
              contender,
              grant.coordinators.map((pin) => pin.path),
            ),
          ),
        ).toEqual([true, true]);
      },
    );
  });
});

it.skipIf(process.platform === "win32")(
  "a surviving child pin excludes config writers after its parent dies",
  async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const launch = (code: string, args: string[] = []) =>
        spawn(
          process.execPath,
          ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "-e", code, ...args],
          { env: { ...process.env, ...state.env }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
      const parent = launch(`
      import {withUpdateWriterCustody,beginUpdateWriterCustody,captureUpdateWriterCustody} from ${JSON.stringify(custodyModule)};
      await withUpdateWriterCustody(()=>{},async()=>{
        await beginUpdateWriterCustody(process.env);
        process.send(captureUpdateWriterCustody());
        setInterval(()=>{},1000);
        await new Promise(()=>{});
      });
    `);
      const parentClosed = once(parent, "close");
      let child: ReturnType<typeof launch> | undefined;
      let childClosed: Promise<unknown> | undefined;
      try {
        const [grant] = await once(parent, "message", { signal: AbortSignal.timeout(30_000) });
        expect(grant.config[0].path).toBe(state.configPath);
        expect(await fs.stat(`${state.configPath}.lock`)).toBeDefined();
        child = launch(
          `
        import {withUpdateWriterCustody} from ${JSON.stringify(custodyModule)};
        await withUpdateWriterCustody(()=>{},async()=>{
          process.send('pinned');
          await new Promise(resolve=>process.once('message',resolve));
        },JSON.parse(process.argv[1]));
        process.disconnect();
      `,
          [JSON.stringify(grant)],
        );
        childClosed = once(child, "close");
        await once(child, "message", { signal: AbortSignal.timeout(30_000) });
        parent.kill("SIGKILL");
        await parentClosed;
        const attempt = `
        import {withConfigWriteLock} from ${JSON.stringify(configModule)};
        import {withStateDatabaseCoordinatorRuntimeDirectory} from ${JSON.stringify(lifecycleModule)};
        try { await withStateDatabaseCoordinatorRuntimeDirectory({directory:process.argv[2],keepAlive:false},
          ()=>withConfigWriteLock(process.argv[1],async()=>{}));process.stdout.write('admitted'); }
        catch(error) { process.stdout.write(error.message); }
      `;
        expect(peer(attempt, [state.configPath, grant.runtimeDirectory])).not.toBe("admitted");
        expect(await fs.stat(`${state.configPath}.lock`)).toBeDefined();
        child.send("release");
        await childClosed;
        expect(peer(attempt, [state.configPath, grant.runtimeDirectory])).toBe("admitted");
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) {
          parent.kill("SIGKILL");
        }
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await parentClosed;
        await childClosed;
      }
    });
  },
);

it("disposes exact maintenance native handles after executor revocation", async () => {
  const { beginDoctorMaintenance } = await import("../../commands/doctor-maintenance.js");
  const { openOpenClawStateDatabase } = await import("../../state/openclaw-state-db.js");
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    await state.writeConfig({ plugins: { enabled: false } });
    let revoked = false;
    let paths: string[] = [];
    await withUpdateWriterCustody(
      () => {
        if (revoked) {
          throw new Error("revoked executor");
        }
      },
      async () => {
        await beginUpdateWriterCustody(state.env);
        paths = captureUpdateWriterCustody()!.coordinators.map((pin) => pin.path);
        const maintenance = await beginDoctorMaintenance({
          root: null,
          options: { repair: true },
          runtime: { log() {}, error() {}, exit() {} },
        });
        if (!maintenance) {
          throw new Error("Expected maintenance owner");
        }
        const db = maintenance.run(() => openOpenClawStateDatabase({ env: state.env }));
        revoked = true;
        await maintenance.release();
        expect(db.db.isOpen).toBe(false);
      },
    );
    expect(JSON.parse(peer(contender, paths))).toEqual([true, true]);
  });
});
