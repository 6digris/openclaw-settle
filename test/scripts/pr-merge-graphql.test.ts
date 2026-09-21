import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const helper = join(process.cwd(), "scripts/pr-lib/merge-graphql.mjs");

function runRead(mode: string) {
  const root = temps.make("pr-writer-graphql-");
  const capture = join(root, "request.json");
  writeFileSync(
    join(root, "gh"),
    `#!${process.execPath}
import fs from "node:fs";
fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  payload: JSON.parse(fs.readFileSync(0, "utf8")),
}));
console.log(JSON.stringify({data: {repository: {id: "publisher-view"}}}));
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.execPath,
    [helper, mode, "github.example:8443", "fixture/repo", "123"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
        FIXTURE_CAPTURE: capture,
      },
    },
  );
  return { ...result, capture };
}

describe.skipIf(process.platform === "win32")("publishing-account GraphQL merge reads", () => {
  it.each(["observe", "preview"])("preserves enterprise hostname ports for %s", (mode) => {
    const result = runRead(mode);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ data: { repository: { id: "publisher-view" } } });
    const request = JSON.parse(readFileSync(result.capture, "utf8"));
    expect(request.args).toEqual([
      "api",
      "graphql",
      "--hostname",
      "github.example:8443",
      "-H",
      "Cache-Control: max-age=0",
      "--input",
      "-",
    ]);
    expect(request.payload.variables).toEqual({ owner: "fixture", name: "repo", number: 123 });
    expect(request.payload.query).toMatch(/^query\(/);
  });

  it("rejects a mutation operation before invoking GitHub", () => {
    const result = runRead("mutation");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected a merge observe or preview read");
    expect(existsSync(result.capture)).toBe(false);
  });
});
