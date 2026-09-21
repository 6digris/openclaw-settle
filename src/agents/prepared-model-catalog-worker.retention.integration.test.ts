import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { PROVIDER_ID } from "./prepared-model-catalog-worker.test-support.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

// Bun does not expose synchronous worker-local GC through node:v8.
const retentionIt = process.versions.bun ? it.skip : it;

retentionIt("releases retired catalog inputs while the shared worker stays live", async () => {
  vi.stubEnv("CODEX_HOME", makeTempDir("catalog-retention-empty-codex-"));
  let observations = "";
  const fixture = await createCatalogFleetFixture(makeTempDir)(({ root }) => {
    observations = path.join(root, "retention.jsonl");
    fs.writeFileSync(
      path.join(root, "plugin", "index.cjs"),
      `const fs = require("node:fs");
const { setImmediate } = require("node:timers/promises");
require("node:v8").setFlagsFromString("--expose-gc");
const gc = require("node:vm").runInNewContext("gc");
const inputs = [];
const control = new WeakRef({ unowned: true });
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Retention fixture", auth: [],
    catalog: { async run(ctx) {
      // End the WeakRef creation job before collecting previous request inputs.
      await setImmediate();
      gc();
      fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
        retained: inputs.filter(input => input.deref() !== undefined).length,
        observed: inputs.length,
        controlCollected: control.deref() === undefined,
      }) + "\\n");
      inputs.push(new WeakRef(ctx.config));
      return { provider: { api: "openai-completions", baseUrl: "https://retention.invalid/v1",
        models: [{ id: "sqlite-model", name: "Retained catalog " + inputs.length }] } };
    } },
  });
} };`,
    );
  }, true);
  for (let pass = 0; pass < 2; pass++) {
    for (const snapshot of fixture.snapshots) {
      const catalog = await loadCompletedFullCatalog(snapshot, { refresh: true });
      expect(catalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "sqlite-model" }),
      );
    }
  }
  const rows = fs
    .readFileSync(observations, "utf8")
    .trim()
    .split("\n")
    .map(
      (row) => JSON.parse(row) as { retained: number; observed: number; controlCollected: boolean },
    );
  expect(rows.at(-1)?.observed).toBeGreaterThanOrEqual(7);
  expect(rows.every((row) => row.controlCollected)).toBe(true);
  // The prior generation remains admitted until its successor finishes discovery.
  expect(rows.at(-1)?.retained).toBeLessThanOrEqual(1);
});
