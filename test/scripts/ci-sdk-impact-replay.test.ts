import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createChannelContractTestShards } from "../../scripts/lib/channel-contract-test-plan.mts";
import {
  createChangedExtensionFallbackShards,
  createChangedNodeTestShards,
  hasUiE2eAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  createNodeTestShardBundles,
  type NodeTestShardGroup,
} from "../../scripts/lib/ci-node-test-plan.mts";
import { createPluginContractTestShards } from "../../scripts/lib/plugin-contract-test-plan.mts";
import {
  buildVitestRunPlans,
  UI_E2E_VITEST_CONFIG,
} from "../../scripts/test-projects.test-support.mts";
import corpus from "../fixtures/ci-sdk-impact-census.json" with { type: "json" };

const failureSets = new Map(
  Object.entries(corpus.failureRanges).map(([key, ranges]): [string, number[]] => [
    key,
    ranges.flatMap(([first, last]) => {
      if (first === undefined || last === undefined || first > last) {
        throw new Error(`Invalid failure range in ${key}`);
      }
      return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
    }),
  ]),
);
const contracts = [...createChannelContractTestShards(), ...createPluginContractTestShards()];

// Successful and skipped runs remain in the replay corpus. Only observed failed
// tests supply a non-vacuous coverage assertion for this regression guard.
describe.each(corpus.runs.filter((run) => run.failedNodeFiles))("C2 run $id", (run) => {
  it("retains every historical failed test still present in the checkout", () => {
    if (!run.changedPaths || !run.failedNodeFiles || typeof run.runUiTests !== "boolean") {
      throw new Error("A failed Node test must have an observed changed set and failure record");
    }
    const dedicatedUiE2e = run.runUiTests && hasUiE2eAffectingChange(run.changedPaths);
    const selected = createChangedNodeTestShards(run.changedPaths, {
      runnerBackend: run.runnerBackend ?? undefined,
      dedicatedContractShards: contracts,
      dedicatedUiE2e,
      dedicatedMaxLinesRatchet: true,
    });
    const extensions =
      selected === null ? createChangedExtensionFallbackShards(run.changedPaths) : [];
    const rows = selected ?? [
      ...createNodeTestShardBundles({
        changedPaths: run.changedPaths,
        compactMode: "pull-request",
        compactNodeJobCap: 130 - extensions.filter((row) => !row.requiresDist).length,
        includeReleaseOnlyPluginShards: false,
        runnerBackend: run.runnerBackend ?? undefined,
      }),
      ...extensions,
    ];
    const groups = rows.flatMap<Pick<NodeTestShardGroup, "configs" | "includePatterns" | "env">>(
      (row) => row.groups ?? ("configs" in row ? [row] : []),
    );
    const explicit = new Set([
      ...rows.flatMap((row) => ("targets" in row ? (row.targets ?? []) : [])),
      ...groups.flatMap((group) => group.includePatterns ?? []),
    ]);
    const wholeConfigs = new Set(
      groups.filter((group) => !group.includePatterns?.length).flatMap((group) => group.configs),
    );
    const nativeShards = new Map<string, { total: number; indices: Set<number> }>();
    for (const group of groups) {
      const args: unknown = JSON.parse(group.env?.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON ?? "[]");
      if (!Array.isArray(args)) {
        throw new Error("Invalid native shard arguments");
      }
      for (const arg of args) {
        if (typeof arg !== "string") {
          throw new Error("Invalid native shard argument");
        }
        const match = /^--shard=(\d+)\/(\d+)$/u.exec(arg);
        if (!match) {
          continue;
        }
        const key = JSON.stringify([group.configs, group.includePatterns]);
        const total = Number(match[2]);
        const generation = nativeShards.get(key) ?? { total, indices: new Set<number>() };
        expect(total).toBe(generation.total);
        generation.indices.add(Number(match[1]));
        nativeShards.set(key, generation);
      }
    }
    for (const { total, indices } of nativeShards.values()) {
      expect([...indices].toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: total }, (_, index) => index + 1),
      );
    }

    const failed = (failureSets.get(run.failedNodeFiles) ?? []).map((index) => {
      const file = corpus.testFiles[index];
      if (!file) {
        throw new Error(`Invalid failed-file index: ${index}`);
      }
      return file;
    });
    expect(failed.length).toBeGreaterThan(0);
    const unavailable = failed.filter((file) => !existsSync(file));
    if (unavailable.length) {
      // Keep deleted/PR-only files in the immutable oracle and visible in proof;
      // neither the baseline nor this planner can execute absent historical files.
      console.info(
        `[sdk-census ${run.id}] unavailable historical files: ${unavailable.join(", ")}`,
      );
    }
    const missing = failed.filter((file) => {
      if (unavailable.includes(file) || explicit.has(file)) {
        return false;
      }
      if (
        [...explicit].some((pattern) => pattern.includes("*") && path.matchesGlob(file, pattern))
      ) {
        return false;
      }
      if (
        contracts.some((contract) =>
          contract.includePatterns.some((pattern) => path.matchesGlob(file, pattern)),
        )
      ) {
        return false;
      }
      const plans = buildVitestRunPlans([file]);
      return (
        plans.length === 0 ||
        !plans.every(
          (plan) =>
            wholeConfigs.has(plan.config) ||
            (dedicatedUiE2e && plan.config === UI_E2E_VITEST_CONFIG),
        )
      );
    });
    expect(missing, `https://github.com/openclaw/openclaw/actions/runs/${run.id}`).toEqual([]);
  });
});
