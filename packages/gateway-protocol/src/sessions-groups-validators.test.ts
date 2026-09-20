import { describe, expect, it } from "vitest";
import {
  validateSessionsGroupsDefaultsParams,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsDefaultsResult,
  validateSessionsGroupsListResult,
  validateSessionsGroupsMutationResult,
  validateSessionsGroupsUpdateParams,
  validateSessionsGroupsUpdateResult,
} from "./index.js";

describe("session group result validators", () => {
  it("accepts legacy gateway payloads without sectionOrder", () => {
    expect(validateSessionsGroupsListResult({ groups: [] })).toBe(true);
    expect(validateSessionsGroupsMutationResult({ ok: true, groups: [] })).toBe(true);
  });

  it("accepts group defaults", () => {
    expect(validateSessionsGroupsListResult({ groups: [{ name: "Client", position: 0 }] })).toBe(
      true,
    );
    expect(
      validateSessionsGroupsListResult({
        groups: [{ name: "Client", position: 0, cwd: "/repos/client" }],
      }),
    ).toBe(false);
    expect(
      validateSessionsGroupsDefaultsResult({
        defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(
      validateSessionsGroupsUpdateResult({
        ok: true,
        defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(validateSessionsGroupsUpdateParams({ name: "Client", cwd: null, worktree: false })).toBe(
      true,
    );
  });
});

describe("session group owner request validators", () => {
  it.each([
    { validate: validateSessionsGroupsListParams, params: {} },
    { validate: validateSessionsGroupsDefaultsParams, params: {} },
    { validate: validateSessionsGroupsPutParams, params: { names: ["Shared"] } },
    { validate: validateSessionsGroupsRenameParams, params: { name: "Shared", to: "Other" } },
    { validate: validateSessionsGroupsDeleteParams, params: { name: "Shared" } },
    {
      validate: validateSessionsGroupsUpdateParams,
      params: { name: "Shared", cwd: null, worktree: false },
    },
  ])(
    "accepts explicit owners and legacy requests, rejecting invalid owner values ($validate)",
    ({ validate, params }) => {
      expect(validate(params)).toBe(true);
      expect(validate({ ...params, agentId: "beta" })).toBe(true);
      expect(validate({ ...params, agentId: "" })).toBe(false);
      expect(validate({ ...params, agentId: 1 })).toBe(false);
      expect(validate({ ...params, agentId: null })).toBe(false);
    },
  );

  it("accepts bounded migration identifiers and rejects malformed inputs", () => {
    const input = { agentId: "beta", names: ["Imported"], append: true };
    expect(validateSessionsGroupsPutParams({ ...input, importId: "source-123" })).toBe(true);
    for (const importId of ["", "   ", "x".repeat(129), null, 1]) {
      expect(validateSessionsGroupsPutParams({ ...input, importId })).toBe(false);
    }
  });

  it("accepts append creation without changing the result wire shape", () => {
    expect(
      validateSessionsGroupsPutParams({ agentId: "beta", names: ["Imported"], append: true }),
    ).toBe(true);
    expect(
      validateSessionsGroupsPutParams({
        agentId: "beta",
        names: [],
        append: false,
        sectionOrder: [],
      }),
    ).toBe(true);
    expect(validateSessionsGroupsPutParams({ agentId: "beta", names: [], append: "true" })).toBe(
      false,
    );
    expect(
      validateSessionsGroupsMutationResult({
        ok: true,
        groups: [{ name: "Imported", position: 0 }],
        sectionOrder: [],
      }),
    ).toBe(true);
  });
});
