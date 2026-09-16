import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareBundledPluginRuntime } from "../../../scripts/stage-bundled-plugin-runtime.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as updateCheck from "../../infra/update-check.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { completeSourceUpdateRuntime } from "./update-command-runtime.js";
import * as maintenance from "./update-command-service-maintenance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["unchanged", "changed", "parking-failed", "legacy-parking-failed"] as const)(
  "prepares source artifacts online and obtains publication authority only for changes (%s)",
  async (outcome) => {
    const root = dirs.make("source-runtime-publication-");
    const events = path.join(root, "events.txt");
    await fs.mkdir(path.join(root, "scripts", "lib"), { recursive: true });
    await fs.writeFile(
      path.join(root, "scripts", "stage-bundled-plugin-runtime.mts"),
      `import fs from "node:fs";
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + "\\n");
export function prepareBundledPluginRuntime() {
  record("prepared");
  return { changed: ${outcome !== "unchanged"}, originalsIntact: ${outcome === "legacy-parking-failed" ? "undefined" : "true"}, async publish(assertCurrent) { await assertCurrent(); record("published"); }, async cleanup() { record("cleaned"); } };
}`,
    );
    await fs.writeFile(
      path.join(root, "scripts", "lib", "dist-artifact-ownership.mts"),
      "export async function withDistArtifactOwnership(root, run) { return await run(); }\n",
    );
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("git");
    const guard = vi
      .spyOn(maintenance, "withGatewayRuntimeArtifactPublication")
      .mockImplementation(async (_params, publish) => {
        expect(await fs.readFile(events, "utf8")).toBe("prepared\nparked\n");
        return await publish(async () => {});
      });
    const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
    const operation = withEnvAsync(env, () =>
      withPluginLifecycleLease({}, (lease) =>
        completeSourceUpdateRuntime({
          root,
          timeoutMs: 1_000,
          lease,
          beforePublication: async () => {
            if (outcome.endsWith("parking-failed")) {
              throw new Error("native parking failed");
            }
            await fs.appendFile(events, "parked\n");
          },
        }),
      ),
    );
    if (outcome.endsWith("parking-failed")) {
      await expect(operation).rejects.toMatchObject({
        name: outcome === "legacy-parking-failed" ? "Error" : "UpdatePreMutationError",
        message:
          outcome === "legacy-parking-failed"
            ? expect.stringContaining("cannot attest original restoration")
            : "native parking failed",
      });
    } else {
      await expect(operation).resolves.toEqual({ changed: outcome === "changed" });
    }
    expect(await fs.readFile(events, "utf8")).toBe(
      outcome === "changed" ? "prepared\nparked\npublished\ncleaned\n" : "prepared\ncleaned\n",
    );
    expect(guard).toHaveBeenCalledTimes(outcome === "changed" ? 1 : 0);
  },
);

it.each([false, true])(
  "reports actual original restoration after a failed second rename (restore fails=%s)",
  async (restoreFails) => {
    const root = dirs.make("runtime-original-restoration-");
    const runtimeRoot = path.join(root, "dist-runtime");
    const aliasRoot = path.join(root, "dist", "extensions", "node_modules", "openclaw");
    await fs.mkdir(runtimeRoot, { recursive: true });
    await fs.mkdir(aliasRoot, { recursive: true });
    await fs.mkdir(path.join(root, "dist", "plugin-sdk"));
    await fs.writeFile(path.join(runtimeRoot, "original.txt"), "original runtime");
    await fs.writeFile(path.join(aliasRoot, "original.txt"), "original SDK alias");
    await withEnvAsync({ OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS: "0" }, async () => {
      const prepared = prepareBundledPluginRuntime({ repoRoot: root });
      expect(prepared.changed).toBe(true);
      expect(prepared.originalsIntact).toBe(true);
      const rename = syncFs.renameSync;
      let retainedOriginal: string | undefined;
      vi.spyOn(syncFs, "renameSync").mockImplementation((source, destination) => {
        if (String(destination) === aliasRoot && path.basename(String(source)) === "candidate") {
          throw new Error("fixture alias publication failed");
        }
        if (
          restoreFails &&
          String(destination) === aliasRoot &&
          path.basename(String(source)) === "previous"
        ) {
          retainedOriginal = String(source);
          throw new Error("fixture alias restoration failed");
        }
        rename(source, destination);
      });
      await expect(prepared.publish(() => {})).rejects.toThrow(
        restoreFails
          ? "Runtime publication and restoration failed"
          : "fixture alias publication failed",
      );
      expect(prepared.originalsIntact).toBe(!restoreFails);
      await prepared.cleanup();
      expect(await fs.readFile(path.join(runtimeRoot, "original.txt"), "utf8")).toBe(
        "original runtime",
      );
      expect(
        await fs.readFile(
          path.join(restoreFails ? retainedOriginal! : aliasRoot, "original.txt"),
          "utf8",
        ),
      ).toBe("original SDK alias");
      if (restoreFails) {
        await expect(fs.access(aliasRoot)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  },
);
