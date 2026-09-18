import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import {
  resolveConfigValue,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("command-backed authentication through the spawn broker", () => {
  let host: SpawnBrokerHost;
  beforeAll(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
  });
  afterAll(async () => {
    await host.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function commandFixture(command: string) {
    const directory = tempDirs.make("openclaw-auth-command-");
    const parentFile = join(directory, "parents");
    const quotedPath = `'${parentFile.replaceAll("'", "'\\''")}'`;
    return {
      config: `!printf '%s\\n' "$PPID" >> ${quotedPath}; ${command}`,
      async expectBrokerSpawns(count: number) {
        const parents = (await readFile(parentFile, "utf8")).trim().split("\n").map(Number);
        expect(parents).toEqual(Array.from({ length: count }, () => host.pid));
        expect(parents).not.toContain(process.pid);
      },
    };
  }

  function registryFixture(
    storage: AuthStorage,
    commands: { key?: string; providerHeader: string; modelHeader: string },
  ) {
    const registry = ModelRegistry.inMemory(storage);
    registry.registerProvider("broker-fixture", {
      baseUrl: "https://models.example/v1",
      api: "openai-responses",
      apiKey: commands.key,
      headers: { "X-Provider": commands.providerHeader },
      authHeader: true,
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 512,
          headers: { "X-Model": commands.modelHeader },
        },
      ],
    });
    return { registry, model: registry.find("broker-fixture", "fixture")! };
  }

  it.each(["api_key", "token"] as const)(
    "resolves concurrent stored %s commands once without forking the Gateway",
    async (type) => {
      const fixture = commandFixture('printf "  %s  \\n" "$OPENCLAW_AUTH_COMMAND_FIXTURE"');
      vi.stubEnv("OPENCLAW_AUTH_COMMAND_FIXTURE", "synthetic-first");
      const storage = AuthStorage.inMemory({
        "broker-fixture":
          type === "api_key"
            ? { type, key: fixture.config }
            : { type, token: fixture.config, expires: Date.now() + 60_000 },
      });

      const results = await runWithSpawnBroker(host, () =>
        Promise.all([storage.getApiKey("broker-fixture"), storage.getApiKey("broker-fixture")]),
      );
      expect(results).toEqual(["synthetic-first", "synthetic-first"]);
      vi.stubEnv("OPENCLAW_AUTH_COMMAND_FIXTURE", "synthetic-second");
      expect(await runWithSpawnBroker(host, () => storage.getApiKey("broker-fixture"))).toBe(
        "synthetic-first",
      );
      await fixture.expectBrokerSpawns(1);
    },
  );

  it("reruns provider keys and request headers with the current environment", async () => {
    const fixture = commandFixture('printf "%s" "$OPENCLAW_AUTH_COMMAND_FIXTURE"');
    const { registry, model } = registryFixture(AuthStorage.inMemory(), {
      key: fixture.config,
      providerHeader: fixture.config,
      modelHeader: fixture.config,
    });

    for (const value of ["synthetic-first", "synthetic-second"]) {
      vi.stubEnv("OPENCLAW_AUTH_COMMAND_FIXTURE", value);
      expect(
        await runWithSpawnBroker(host, () => registry.getApiKeyForProvider("broker-fixture")),
      ).toBe(value);
      expect(await runWithSpawnBroker(host, () => registry.getApiKeyAndHeaders(model))).toEqual({
        ok: true,
        apiKey: value,
        headers: { "X-Provider": value, "X-Model": value, Authorization: `Bearer ${value}` },
      });
    }
    await fixture.expectBrokerSpawns(8);
  });

  it("rejects credentials replaced while headers resolve and preserves command order", async () => {
    const directory = tempDirs.make("openclaw-auth-command-order-");
    const orderFile = join(directory, "order");
    const releaseFile = join(directory, "release");
    const quotedOrder = `'${orderFile.replaceAll("'", "'\\''")}'`;
    const quotedRelease = `'${releaseFile.replaceAll("'", "'\\''")}'`;
    const key = commandFixture(`printf 'key\\n' >> ${quotedOrder}; printf synthetic-key`);
    const provider = commandFixture(
      `printf 'provider\\n' >> ${quotedOrder}; while [ ! -e ${quotedRelease} ]; do sleep 0.01; done; printf synthetic-provider`,
    );
    const modelHeader = commandFixture(
      `printf 'model\\n' >> ${quotedOrder}; printf synthetic-model`,
    );
    const storage = AuthStorage.inMemory({
      "broker-fixture": { type: "api_key", key: key.config },
    });
    const { registry, model } = registryFixture(storage, {
      providerHeader: provider.config,
      modelHeader: modelHeader.config,
    });
    const pending = runWithSpawnBroker(host, () => registry.getApiKeyAndHeaders(model));
    try {
      await vi.waitFor(async () => {
        expect(await readFile(orderFile, "utf8")).toBe("key\nprovider\n");
      });
      storage.setRuntimeApiKey("broker-fixture", "synthetic-replacement");
    } finally {
      await writeFile(releaseFile, "release");
    }

    expect(await pending).toEqual({
      ok: false,
      error: 'Authentication changed while resolving request headers for "broker-fixture"',
    });
    expect(await readFile(orderFile, "utf8")).toBe("key\nprovider\nmodel\n");
    await key.expectBrokerSpawns(1);
    await provider.expectBrokerSpawns(1);
    await modelHeader.expectBrokerSpawns(1);
  });

  it.each(["printf 'discarded'; exit 3", "printf '  \\n'"])(
    "caches unsuccessful stored commands but retries uncached values: %s",
    async (command) => {
      const fixture = commandFixture(command);
      await runWithSpawnBroker(host, async () => {
        expect(await resolveConfigValue(fixture.config)).toBeUndefined();
        expect(await resolveConfigValue(fixture.config)).toBeUndefined();
        expect(await resolveConfigValueUncached(fixture.config)).toBeUndefined();
        await expect(
          Promise.resolve().then(() =>
            resolveHeadersOrThrow({ "X-Fixture": fixture.config }, "fixture provider"),
          ),
        ).rejects.toThrow(
          'Failed to resolve fixture provider header "X-Fixture" from shell command',
        );
      });
      await fixture.expectBrokerSpawns(3);
    },
  );

  it("rejects output beyond the existing 1 MiB command limit", async () => {
    const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const fixture = commandFixture(
      `exec ${executable} -e 'process.stdout.write("x".repeat(1024 * 1024 + 1))'`,
    );
    expect(
      await runWithSpawnBroker(host, () => resolveConfigValueUncached(fixture.config)),
    ).toBeUndefined();
    await fixture.expectBrokerSpawns(1);
  });

  it("keeps literal and environment values uncached", async () => {
    await runWithSpawnBroker(host, async () => {
      for (const value of ["synthetic-first", "synthetic-second", ""]) {
        vi.stubEnv("OPENCLAW_AUTH_COMMAND_FIXTURE", value);
        expect(await resolveConfigValue("OPENCLAW_AUTH_COMMAND_FIXTURE")).toBe(
          value || "OPENCLAW_AUTH_COMMAND_FIXTURE",
        );
        expect(await resolveConfigValueUncached("OPENCLAW_AUTH_COMMAND_FIXTURE")).toBe(
          value || "OPENCLAW_AUTH_COMMAND_FIXTURE",
        );
      }
      expect(await resolveConfigValue("synthetic-literal")).toBe("synthetic-literal");
    });
  });
});
