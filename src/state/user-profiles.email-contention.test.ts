import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import {
  captureStateDatabaseCoordinatorRuntime,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import { listUserProfilesSync } from "./user-profile-list.js";
import {
  ensureProfileForEmail,
  getUserProfileListItem,
  linkEmail,
  setDisplayName,
  setUserProfileRole,
} from "./user-profiles.js";

it.each(["existing", "missing", "concurrent creation"] as const)(
  "resolves %s email identities during an unrelated canonical write",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await withStateDatabaseCoordinatorRuntimeDirectory(state.path("coordinators"), async () => {
        const options = { path: state.statePath("openclaw.sqlite") };
        const existing = ensureProfileForEmail("existing@example.test", options);
        const writer = ensureProfileForEmail("writer@example.test", options);
        ensureProfileForEmail("linked@example.test", options);
        linkEmail("linked@example.test", existing.id, options);
        setDisplayName(existing.id, "Saved name", options);
        setUserProfileRole(existing.id, "maintainer", options);
        const expected = ensureProfileForEmail("linked@example.test", options);
        const email = scenario === "existing" ? "linked@example.test" : "new@example.test";
        const version = readUserProfileVersion();
        const flags = new Int32Array(new SharedArrayBuffer(8));
        const worker = new Worker(
          new URL("./user-profiles.email-contention.worker.test-support.mjs", import.meta.url),
          {
            execArgv: [],
            workerData: {
              flags: flags.buffer,
              options,
              writerId: writer.id,
              createEmail: scenario === "concurrent creation" ? email : undefined,
              runtime: captureStateDatabaseCoordinatorRuntime(),
              sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
              coordinatorUrl: new URL("../infra/state-database-coordinator.ts", import.meta.url)
                .href,
              stateUrl: new URL("./openclaw-state-db.ts", import.meta.url).href,
              profilesUrl: new URL("./user-profiles.ts", import.meta.url).href,
            },
          },
        );
        const exited = new Promise<number>((resolve) => {
          worker.once("exit", resolve);
        });
        try {
          const [ready] = await once(worker, "message", { signal: AbortSignal.timeout(15_000) });
          expect(ready.held).toBe(true);
          expect(Atomics.load(flags, 0)).toBe(1);
          // A current read remains available while the independent writer owns its transaction.
          expect(getUserProfileListItem(existing.id, options)).toMatchObject(expected);
          expect(Atomics.load(flags, 0)).toBe(1);
          Atomics.store(flags, 1, 1);
          Atomics.notify(flags, 1);
          const resolved = ensureProfileForEmail(`  ${email.toUpperCase()} `, options);
          const phaseAtReturn = Atomics.load(flags, 0);
          if (scenario === "existing") {
            expect(phaseAtReturn).toBe(1);
            expect(resolved).toEqual(expected);
          } else {
            expect(phaseAtReturn).toBe(2);
            expect(resolved).toMatchObject({ displayName: "new", mergedInto: null });
            expect(resolved).not.toHaveProperty("role");
            if (scenario === "concurrent creation") {
              expect(resolved).toEqual(ready.created);
            }
          }
          expect(readUserProfileVersion()).toBe(version + (scenario === "missing" ? 1 : 0));
          Atomics.store(flags, 1, 2);
          Atomics.notify(flags, 1);
          expect(await exited).toBe(0);
          expect(getUserProfileListItem(writer.id, options).displayName).toBe("Committed writer");
          expect(
            listUserProfilesSync(options).filter((profile) => profile.emails.includes(email)),
          ).toEqual([expect.objectContaining({ id: resolved.id })]);
        } finally {
          Atomics.store(flags, 1, 2);
          Atomics.notify(flags, 1);
          await worker.terminate();
        }
      });
    });
  },
);
