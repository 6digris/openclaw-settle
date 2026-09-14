import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createGatewayChatMetadataRuntime } from "./chat-metadata-runtime.js";
import type { prepareChatMetadataModelProjection } from "./chat-metadata-session-projection.js";
import type { GatewayRequestContext } from "./types.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
type ModelProjection = Awaited<ReturnType<typeof prepareChatMetadataModelProjection>>;
type Tracked<T extends object> = { label: string; weak: WeakRef<T> };
const config: OpenClawConfig = {
  agents: { entries: { main: { default: true }, work: {} } },
};
const authStore: AuthProfileStore = { version: 1, profiles: {} };
const context = {} as GatewayRequestContext;
const isCurrent = () => true;
const metadataSnapshot = createPluginMetadataSnapshotFixture();

function owner(agentId: string, revision: number): PreparedModelRuntimeSnapshot {
  const workspaceDir = `/synthetic/${agentId}/workspace`;
  return {
    catalogOwner: { agentId, workspaceDir },
    agentId,
    agentDir: `/synthetic/${agentId}/agent`,
    workspaceDir,
    activeProjectKeys: [],
    config,
    observationConfig: config,
    isCurrent,
    authModes: {},
    metadataSnapshot,
    allowGatewaySubagentBinding: false,
    modelCatalog: {
      entries: [{ id: `${agentId}-${revision}`, name: "Synthetic model", provider: "synthetic" }],
      routeVariants: [],
    },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => {
      throw new Error("Metadata retention proof must not open stores");
    },
  };
}

// The injected leaf must not capture its caller's owner or generation facts.
function leafProjection(entries: ModelCatalogEntry[]): ModelProjection {
  return { modelCatalog: entries, read: () => ({ models: entries }), isCurrent };
}

function createHarness() {
  const owners = new Map([
    ["main", owner("main", 0)],
    ["work", owner("work", 0)],
  ]);
  const retiredOwners: Tracked<PreparedModelRuntimeSnapshot>[] = [];
  const sessionLeaves: Tracked<ModelProjection>[] = [];
  const runtime = createGatewayChatMetadataRuntime({
    getConfig: () => config,
    getContext: () => context,
    log: {
      warn: (message) => {
        throw new Error(message);
      },
    },
    deps: {
      getPreparedOwner: ({ agentId }) => owners.get(agentId ?? "main"),
      getPreparedAuthStore: () => authStore,
      getAuthStoreRevision: () => 1,
      getSkillsVersion: () => 1,
      getPluginRegistryVersion: () => 1,
      buildCommands: async () => ({ commands: [] }),
      buildProjection: async ({ facts, preferredProfileId }) => {
        const leaf = leafProjection(facts.modelCatalog.entries);
        if (preferredProfileId) {
          sessionLeaves.push({ label: preferredProfileId, weak: new WeakRef(leaf) });
        }
        return leaf;
      },
    },
  });
  return {
    runtime,
    retiredOwners,
    sessionLeaves,
    rotate(agentId: string, revision: number) {
      const previous = owners.get(agentId);
      assert.ok(previous);
      retiredOwners.push({ label: `${agentId}-${revision - 1}`, weak: new WeakRef(previous) });
      owners.set(agentId, owner(agentId, revision));
    },
  };
}

async function populate(harness: ReturnType<typeof createHarness>) {
  await harness.runtime.refresh();
  for (let index = 0; index < 12; index += 1) {
    const agentId = index % 2 === 0 ? "main" : "work";
    const response = await harness.runtime.read({
      agentId,
      sessionKey: `agent:${agentId}:synthetic-${index}`,
      sessionEntry: {
        authProfileOverride: `shared:synthetic-${index}`,
        authProfileOverrideSource: "user",
      },
    });
    assert.equal(response.models?.length, 1);
    harness.rotate(agentId, Math.floor(index / 2) + 1);
    await harness.runtime.refresh();
  }
}

function unownedControl() {
  return new WeakRef({ unowned: true });
}

const harness = createHarness();
const control = unownedControl();
try {
  await populate(harness);
  // All refreshes settled and the setup scope returned; no parked caller owns the old pages.
  for (let pass = 0; pass < 12; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "The unowned control must collect");
  const retained = <T extends object>(tracked: Tracked<T>[]) =>
    tracked.flatMap(({ label, weak }) => (weak.deref() ? [label] : []));
  const retiredOwners = retained(harness.retiredOwners);
  const retiredSessionLeaves = retained(harness.sessionLeaves);
  for (const agentId of ["main", "work"]) {
    const response = await harness.runtime.read({ agentId });
    assert.equal(response.models?.[0]?.id, `${agentId}-6`);
  }
  process.stdout.write(JSON.stringify({ retiredOwners, retiredSessionLeaves }));
} finally {
  await harness.runtime.stop();
}
