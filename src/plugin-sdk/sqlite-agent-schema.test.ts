import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";

describe("SQLite agent schema entrypoint", () => {
  it("keeps connection lifecycle and schema mutation owners outside its import closure", () => {
    expect(
      findSourceImportBackedges("src/plugin-sdk/sqlite-agent-schema.ts", [
        "src/state/openclaw-agent-db.ts",
        "src/state/openclaw-agent-db-maintenance.ts",
        "src/state/openclaw-agent-db-schema.ts",
        "src/state/openclaw-agent-db-lease.ts",
        "src/state/openclaw-state-db.ts",
        "src/infra/sqlite-transaction.ts",
      ]),
    ).toEqual([]);
  });
});
