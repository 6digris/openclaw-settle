import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scenario = readFileSync("scripts/e2e/lib/plugin-update/corrupt-update-scenario.sh", "utf8");
const recovery = scenario.slice(scenario.indexOf('mkdir "$npm_registry_dir/recovery"'));
const upstream = recovery
  .split("\n")
  .find((line) => line.startsWith("export OPENCLAW_NPM_REGISTRY_UPSTREAM="));

function recoveryUpstream(env: NodeJS.ProcessEnv): string {
  if (!upstream) {
    throw new Error("recovery scenario does not select its fixture registry upstream");
  }
  return execFileSync("bash", ["-c", `${upstream}\nprintf %s "$OPENCLAW_NPM_REGISTRY_UPSTREAM"`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NPM_CONFIG_REGISTRY: "",
      npm_config_registry: "",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "",
      ...env,
    },
  });
}

describe("corrupt plugin recovery registry", () => {
  it.each([
    {
      env: {
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:40101",
        npm_config_registry: "http://127.0.0.1:40102",
      },
      expected: "http://127.0.0.1:40101",
    },
    { env: { npm_config_registry: "http://127.0.0.1:40102" }, expected: "http://127.0.0.1:40102" },
    {
      env: { OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "http://127.0.0.1:40103" },
      expected: "http://127.0.0.1:40103",
    },
    { env: {}, expected: "https://registry.npmjs.org/" },
  ])("retains the selected core package registry: $expected", ({ env, expected }) => {
    expect(recoveryUpstream(env)).toBe(expected);
  });

  it("starts the recovery overlay only after the unavailable-plugin assertions", () => {
    const negative = scenario.indexOf("assert-corrupt-unavailable");
    const coreInstalled = scenario.indexOf("unavailable-plugin-tolerance");
    const overlay = scenario.indexOf('mkdir "$npm_registry_dir/recovery"');
    expect(negative).toBeGreaterThan(0);
    expect(coreInstalled).toBeGreaterThan(negative);
    expect(overlay).toBeGreaterThan(coreInstalled);
    if (!upstream) {
      throw new Error("recovery scenario does not select its fixture registry upstream");
    }
    expect(recovery.indexOf(upstream)).toBeLessThan(recovery.indexOf("start_npm_fixture_registry"));
  });
});
