import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Step = {
  name: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Job = {
  if?: string;
  "runs-on": string;
  steps: Step[];
  strategy: { matrix: Record<string, unknown> };
};
type Workflow = {
  on: { push?: { branches: string[] }; pull_request?: unknown; pull_request_target?: unknown };
  jobs: Record<string, Job>;
};

const repo = resolve(import.meta.dirname, "../..");
const readYaml = (file: string) => parse(readFileSync(join(repo, file), "utf8"));
const ci: Workflow = readYaml(".github/workflows/ci.yml");
const warmer: Workflow = readYaml(".github/workflows/vitest-cache-warm.yml");
const action: { runs: { steps: Step[] }; outputs: Record<string, { value: string }> } = readYaml(
  ".github/actions/restore-tsgo-cache/action.yml",
);
const temps = useAutoCleanupTempDirTracker(afterEach);
const rows = ["core-1", "core-2", "test-types"];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing compiler cache contract: ${label}`);
  }
  return value;
}

function step(steps: Step[], name: string): Step {
  return required(
    steps.find((candidate) => candidate.name === name),
    name,
  );
}

function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const source = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/gu, "")
    .replace(
      /'(?:[^']|'')*'|\.([A-Za-z_][\w-]*)/gu,
      (token: string, property: string | undefined) =>
        property?.includes("-") ? `[${JSON.stringify(property)}]` : token,
    );
  return runInNewContext(source, {
    fromJSON: (value: string) => JSON.parse(value) as unknown,
    ...context,
  });
}

function interpolate(value: string, context: Record<string, unknown>): string {
  return value.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
    String(evaluate(expression, context)),
  );
}

const warm = required(warmer.jobs["warm-test-types"], "warm-test-types job");
const restore = step(action.runs.steps, "Restore compiler seed");
const save = step(warm.steps, "Save test-type incremental state");

describe("protected incremental typecheck caches", () => {
  it("shares row, toolchain, configuration, and source identity between the sole writer and consumers", () => {
    const warmRestore = step(warm.steps, "Restore test-type incremental state");
    expect(warmRestore.uses).toBe("./.github/actions/restore-tsgo-cache");
    expect(warmRestore.with?.row).toBe("${{ matrix.row }}");
    expect(action.runs.steps.filter((entry) => entry.uses?.startsWith("actions/cache"))).toEqual([
      restore,
    ]);
    expect(restore.uses).toMatch(/^actions\/cache\/restore@/u);
    expect(save.uses).toMatch(/^actions\/cache\/save@/u);
    expect(save.with?.path).toBe(restore.with?.path);
    expect(restore.with?.path).toBe(".artifacts/tsgo-cache");
    expect(save.with?.key).toBe("${{ steps.test-type-cache.outputs.cache-primary-key }}");
    expect(action.outputs["cache-primary-key"]?.value).toBe(
      "${{ steps.restore.outputs.cache-primary-key }}",
    );

    const hashes: string[][] = [];
    const keys = rows.map((row) => {
      const context = {
        inputs: { row },
        runner: { os: "Linux", arch: "X64" },
        hashFiles: (...files: string[]) => {
          hashes.push(files);
          return "toolchain-config";
        },
        steps: { inputs: { outputs: { source: "source-tree" } } },
      };
      const key = interpolate(required(restore.with?.key, "restore key"), context);
      const prefix = interpolate(
        required(restore.with?.["restore-keys"], "restore prefix"),
        context,
      ).trim();
      expect(key).toBe(`Linux-X64-tsgo-v1-${row}-toolchain-config-source-tree`);
      expect(prefix).toBe(`Linux-X64-tsgo-v1-${row}-toolchain-config-`);
      return key;
    });
    expect(new Set(keys).size).toBe(rows.length);
    for (const files of hashes) {
      expect(files).toEqual(
        expect.arrayContaining(["pnpm-lock.yaml", "tsconfig*.json", "test/tsconfig/*.json"]),
      );
    }
  });

  it("keeps PR consumers restore-only and runs checks independently of cache hits", () => {
    const consumers = [
      {
        job: "check-shard",
        restore: "Restore test-type incremental state",
        row: "test-types",
        run: "Run check shard",
      },
      {
        job: "check-test-types-hosted-core-shard",
        restore: "Restore core test-type incremental state",
        row: "core-${{ matrix.stripe }}",
        run: "Run hosted core test-types stripe",
      },
    ];
    for (const consumer of consumers) {
      const job = required(ci.jobs[consumer.job], consumer.job);
      const seed = step(job.steps, consumer.restore);
      const check = step(job.steps, consumer.run);
      expect(seed.uses).toBe("./.ci-harness/.github/actions/restore-tsgo-cache");
      expect(seed.with?.row).toBe(consumer.row);
      expect(job.steps.indexOf(seed)).toBeLessThan(job.steps.indexOf(check));
      expect(job.steps.filter((entry) => entry.with?.path?.includes("tsgo-cache"))).toEqual([]);
      expect(JSON.stringify([check.if, check.env, check.run])).not.toMatch(
        /cache-hit|test-type-cache/u,
      );
      for (const cacheMode of ["restore", "off"]) {
        for (const frozen of ["true", "false"]) {
          expect(
            evaluate(required(seed.if, "consumer restore condition"), {
              matrix: { task: "test-types" },
              needs: { preflight: { outputs: { cache_mode: cacheMode, frozen_target: frozen } } },
            }),
          ).toBe(cacheMode === "restore" && frozen === "false");
        }
      }
    }
    expect(ci.jobs["check-test-types-hosted-core-shard"]?.strategy.matrix.stripe).toEqual([1, 2]);
  });

  it("publishes only after successful checks in the protected warmer", () => {
    expect(warmer.on.push?.branches).toEqual(["main"]);
    expect(warmer.on).not.toHaveProperty("pull_request");
    expect(warmer.on).not.toHaveProperty("pull_request_target");
    for (const repository of ["openclaw/openclaw", "contributor/openclaw"]) {
      expect(
        evaluate(required(warm.if, "warmer repository condition"), { github: { repository } }),
      ).toBe(repository === "openclaw/openclaw");
    }
    expect(step(warm.steps, "Setup Node environment").with?.["cache-mode"]).toBe("read-write");
    const check = step(warm.steps, "Warm test-type incremental state");
    expect(check["continue-on-error"]).not.toBe(true);
    expect(warm.steps.indexOf(check)).toBeLessThan(warm.steps.indexOf(save));
    const condition = required(save.if, "save condition");
    for (const passed of [true, false]) {
      for (const hit of ["true", "false", ""]) {
        for (const mode of ["off", "restore", "read-write"]) {
          // Actions implicitly requires success unless the condition checks status itself.
          const implicitSuccess = /\b(?:success|always|failure|cancelled)\s*\(/u.test(condition)
            ? true
            : passed;
          expect(
            implicitSuccess &&
              evaluate(condition, {
                success: () => passed,
                always: () => true,
                failure: () => !passed,
                cancelled: () => false,
                steps: {
                  "test-type-cache": { outputs: { "cache-hit": hit } },
                  "setup-node-env": { outputs: { "cache-mode": mode } },
                },
              }),
          ).toBe(passed && mode === "read-write" && hit !== "true");
        }
      }
    }
    expect(warm.strategy.matrix.row).toEqual(rows);
  });

  it.each(["hybrid", "github", "blacksmith"])(
    "seeds every row on the %s cache backend(s)",
    (backend) => {
      const vars = { OPENCLAW_CI_RUNNER_BACKEND: backend };
      const platforms = evaluate(String(warm.strategy.matrix.platform), { vars });
      expect(platforms).toEqual(backend === "hybrid" ? ["linux", "linux-hosted"] : ["linux"]);
      for (const platform of backend === "hybrid" ? ["linux", "linux-hosted"] : ["linux"]) {
        expect(evaluate(warm["runs-on"], { matrix: { platform }, vars })).toBe(
          platform === "linux-hosted" || backend === "github"
            ? "ubuntu-24.04"
            : "blacksmith-16vcpu-ubuntu-2404",
        );
      }
      const check = step(warm.steps, "Warm test-type incremental state");
      for (const row of rows) {
        const execution = spawnSync(
          "bash",
          [
            "-c",
            [
              'node() { printf "node %s\\n" "$*"; }',
              'pnpm() { printf "pnpm %s\\n" "$*"; }',
              interpolate(required(check.run, "warmer checks"), { vars }),
            ].join("\n"),
          ],
          { encoding: "utf8", env: { PATH: process.env.PATH, ROW: row } },
        );
        expect(execution.status, execution.stderr).toBe(0);
        const stripe = row === "core-1" ? "1-2/5" : row === "core-2" ? "3-4/5" : "5/5";
        const stripeArgs =
          row === "test-types" && backend === "blacksmith" ? "" : ` --stripe ${stripe}`;
        expect(execution.stdout.trim().split("\n")).toEqual([
          `node scripts/run-tsgo-core-test-shards.mjs${stripeArgs} --concurrency 2`,
          ...(row === "test-types"
            ? ["pnpm tsgo:extensions:test", "pnpm tsgo:scripts", "pnpm tsgo:test:root"]
            : []),
        ]);
      }
    },
  );

  it.each([
    { hit: "true", matched: "exact-key", result: "HIT (exact source)" },
    {
      hit: "false",
      matched: "older-key",
      result: "HIT (compatible seed; compiler revalidates source)",
    },
    { hit: "", matched: "", result: "MISS" },
  ])("logs $result from the real action shell", ({ hit, matched, result }) => {
    const summary = join(temps.make("tsgo-cache-log-"), "summary");
    const log = step(action.runs.steps, "Log compiler cache restore");
    const env = Object.fromEntries(
      Object.entries(log.env ?? {}).map(([key, value]) => [
        key,
        interpolate(value, {
          inputs: { row: "core-1" },
          steps: { restore: { outputs: { "cache-hit": hit, "cache-matched-key": matched } } },
        }),
      ]),
    );
    const execution = spawnSync("bash", ["-c", required(log.run, "restore logging shell")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(execution.status, execution.stderr).toBe(0);
    expect(execution.stdout.trim()).toBe(
      `[tsgo-cache:core-1] ${result}; matched-key=${matched || "none"}`,
    );
    expect(readFileSync(summary, "utf8").trim()).toBe(`- Compiler cache core-1: ${result}`);
  });

  it("propagates a failed compiler before later checks can publish partial state", () => {
    const check = step(warm.steps, "Warm test-type incremental state");
    const execution = spawnSync(
      "bash",
      [
        "-c",
        [
          "node() { return 7; }",
          'pnpm() { echo "unexpected tail check"; }',
          interpolate(required(check.run, "warmer checks"), {
            vars: { OPENCLAW_CI_RUNNER_BACKEND: "hybrid" },
          }),
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ROW: "test-types" },
      },
    );
    expect(execution.status, execution.stderr).toBe(7);
    expect(execution.stdout).toBe("");
  });
});
