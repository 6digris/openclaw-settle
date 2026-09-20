import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { readSessionGroupLegacyIndex } from "./state-migrations.session-group-sources.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs(roots);
});

describe("session group legacy index projection", () => {
  it("does not JSON-decode saved prompts and leaves the source unchanged", () => {
    const pathname = path.join(makeTempDir(roots, "group-index-"), "sessions.json");
    const bytes = JSON.stringify({
      "agent:alpha:main": {
        sessionId: "fixture",
        category: " Work ",
        skillsSnapshot: { prompt: "must-not-decode" },
      },
    });
    fs.writeFileSync(pathname, bytes);
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text.includes("must-not-decode")) {
        throw new Error("saved prompt decoded");
      }
      return parse(text, reviver);
    });
    expect(readSessionGroupLegacyIndex(pathname).entries).toEqual([
      { sessionKey: "agent:alpha:main", category: "Work" },
    ]);
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);
  });

  it.each([
    "not json",
    "[]",
    '{"agent:alpha:main":{"category":"Work"}}',
    '{"agent:alpha:main":{"sessionId":"s","category":42}}',
  ])("rejects malformed metadata: %s", (bytes) => {
    const pathname = path.join(makeTempDir(roots, "group-index-invalid-"), "sessions.json");
    fs.writeFileSync(pathname, bytes);
    expect(() => readSessionGroupLegacyIndex(pathname)).toThrow(/Invalid legacy session/);
  });
});
