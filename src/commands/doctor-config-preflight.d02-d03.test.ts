import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import { runDoctorPluginConvergence } from "./doctor-config-preflight-plugin-verification.js";
import { prepareDoctorMigrationPlugins } from "./doctor-config-preflight-startup.js";

const m = vi.hoisted(() => ({
  events: [] as string[],
  plan: vi.fn(),
  postCore: vi.fn(),
  inspect: vi.fn(),
  smoke: vi.fn(),
  rehearsal: false,
  deferred: false,
  note: vi.fn(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: m.note }));
vi.mock("../agents/agent-scope-config.js", () => ({}));
vi.mock("../config/config-env-vars.js", () => ({}));
vi.mock("../config/io.factory.js", () => ({}));
vi.mock("../config/io.js", () => ({}));
vi.mock("../infra/errors.js", () => ({}));
vi.mock("../infra/state-migrations.messages.js", () => ({}));
vi.mock("../plugins/doctor-contract-registry.js", () => ({}));
vi.mock("../runtime.js", () => ({}));
vi.mock("../state/agent-database-admission.js", () => ({}));
vi.mock("../state/agent-database-startup.js", () => ({}));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({}));
vi.mock("./doctor-config-preflight-checkpoint.js", () => ({}));
vi.mock("./doctor/shared/automatic-startup-config-repair.js", () => ({}));
vi.mock("./doctor-startup-migration-refusal.js", () => ({
  throwStartupMigrationIdentityChanged: () => {
    throw new Error("inputs changed");
  },
  throwStartupMigrationGuardRejected: () => {
    throw new Error("guard rejected");
  },
  throwStartupMigrationRefusal: (message: string) => {
    throw new Error(message);
  },
}));
vi.mock("./doctor-config-preflight-measure.js", () => ({
  measureDoctorConfigPreflightStep: async (_name: string, run: () => unknown) => await run(),
}));
vi.mock("../plugins/runtime-degraded-state.js", () => ({
  setActiveDegradedPlugins: () => {
    m.events.push("quarantine");
  },
  buildDegradedPluginsFromVerificationFailures: (failures: { pluginId: string }[]) =>
    failures.map((f) => ({ pluginId: f.pluginId, diagnostic: { detail: "payload unavailable" } })),
  describePluginAvailabilityFailure: () => ({ message: "payload unavailable" }),
  formatPluginVerificationDiagnostic: (failure: unknown) => failure,
  PLUGIN_AVAILABILITY_POLICY: { severity: "warning" },
}));
vi.mock("../plugins/config-state.js", () => ({
  normalizePluginsConfig: (cfg: unknown) => cfg,
  resolveEffectiveEnableState: () => ({ enabled: true }),
}));
vi.mock("../version.js", () => ({ resolveCompatibilityHostVersion: () => "2026.9.19" }));
vi.mock("../infra/update-rehearsal-paths.js", () => ({
  resolveUpdateRehearsalRoot: () => (m.rehearsal ? "/copied-payload" : undefined),
}));
vi.mock("./doctor/shared/update-phase.js", () => ({
  shouldDeferConfiguredPluginInstallRepair: () => m.deferred,
}));
vi.mock("./doctor/shared/startup-plugin-convergence-plan.js", () => ({
  planStartupPluginConvergence: m.plan,
}));
vi.mock("./doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: m.postCore,
}));
vi.mock("./doctor/shared/plugin-migration-availability.js", () => ({
  inspectPluginMigrationAvailability: m.inspect,
}));
vi.mock("../plugins/active-payload-verification.js", () => ({
  runActivePluginPayloadSmokeCheck: m.smoke,
}));

const inspection = () => ({
  requiredPluginIds: [] as string[],
  inspectionRequiredPluginIds: [] as string[],
  statelessPluginIds: [] as string[],
  runtimePluginAliases: [] as string[],
  pending: [] as {
    pluginId: string;
    reason: string;
    command: string;
    requiresStateMigration?: boolean;
    requiresDoctorInspection?: boolean;
  }[],
});
const source = {
  plugins: { entries: { owner: { enabled: true } } },
  session: { store: "/original/legacy.json" },
};
const snapshot = () =>
  ({
    path: "/config.json",
    exists: true,
    valid: true,
    raw: JSON.stringify(source),
    parsed: source,
    resolved: source,
    runtimeConfig: source,
    sourceConfig: source,
    config: source,
    legacyIssues: [],
    issues: [],
    warnings: [],
    hash: "source-generation",
  }) as ConfigFileSnapshot;
const pending = (extra = {}) => ({
  pluginId: "owner",
  reason: "package unavailable",
  command: "openclaw update repair",
  ...extra,
});

function fixture() {
  const first = { snapshot: snapshot(), pluginMigrationFingerprint: "old" };
  const refreshed = { snapshot: snapshot(), pluginMigrationFingerprint: "new" };
  const state = vi.fn((_result: unknown) => {
    m.events.push("state");
  });
  const read = vi.fn(async () => {
    m.events.push("reread");
    return refreshed;
  });
  const guard = vi.fn(async () => {
    m.events.push("guard");
    return true;
  });
  const deferred = vi.fn(() => {
    m.events.push("deferred");
  });
  const heartbeat = vi.fn(() => {
    m.events.push("heartbeat");
  });
  const params = {
    cfg: source,
    env: {},
    converge: true,
    lease: { heartbeat } as never,
    snapshotRead: first,
    readRefreshedSnapshot: read,
    beforeStateMigrations: guard,
    onWarnings: vi.fn(),
    onDeferredPlugins: deferred,
  };
  const run = async () => {
    const result = await prepareDoctorMigrationPlugins(params);
    state(result);
    return result;
  };
  return { params, run, state, read, guard, deferred, heartbeat, first, refreshed };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.events.length = 0;
  m.rehearsal = false;
  m.deferred = false;
  m.plan.mockResolvedValue({
    required: true,
    installRecords: {
      owner: { source: "path", sourcePath: "/source/plugin", installPath: "/copied/plugin" },
    },
  });
  m.postCore.mockImplementation(async () => {
    m.events.push("converge");
    return {
      changes: [],
      warnings: [],
      smokeFailures: [],
      installRecords: {
        owner: { source: "path", sourcePath: "/source/plugin", installPath: "/fresh/plugin" },
      },
      errored: false,
    };
  });
  m.inspect.mockResolvedValue(inspection());
  m.smoke.mockResolvedValue({ failures: [] });
});

describe("D02/D03 current convergence before state", () => {
  it.each(["required", "inspection", "unknown", "retained-required", "retained-inspection"])(
    "refuses an unavailable %s owner before plugin reread or state",
    async (kind) => {
      const facts = inspection();
      facts.pending = [
        pending(
          kind === "retained-required"
            ? { requiresStateMigration: true }
            : kind === "retained-inspection"
              ? { requiresDoctorInspection: true }
              : {},
        ),
      ];
      if (kind === "required") {
        facts.requiredPluginIds = ["owner"];
      }
      if (kind === "inspection") {
        facts.inspectionRequiredPluginIds = ["owner"];
      }
      // Historical requiredness cannot be erased by a new stateless declaration.
      if (kind.startsWith("retained")) {
        facts.statelessPluginIds = ["owner"];
      }
      m.inspect.mockResolvedValue(facts);
      const f = fixture();
      await expect(f.run()).rejects.toThrow(/owner/);
      expect(f.read).not.toHaveBeenCalled();
      expect(f.state).not.toHaveBeenCalled();
      expect(f.deferred).not.toHaveBeenCalled();
    },
  );
  it("refuses quarantined owners even if a package inspection forgot a pending row", async () => {
    m.postCore.mockResolvedValue({
      changes: [],
      warnings: [],
      smokeFailures: [{ pluginId: "owner" }],
      installRecords: {},
      errored: true,
    });
    const f = fixture();
    await expect(f.run()).rejects.toThrow(/owner/);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.state).not.toHaveBeenCalled();
  });
  it("keeps proven stateless deferral advisory and binds the refreshed generation before state", async () => {
    m.inspect.mockResolvedValue({
      ...inspection(),
      statelessPluginIds: ["owner"],
      pending: [pending()],
    });
    const f = fixture();
    expect(await f.run()).toBe(f.refreshed);
    expect(m.events.indexOf("converge")).toBeLessThan(m.events.indexOf("reread"));
    expect(m.events.indexOf("guard")).toBeLessThan(m.events.indexOf("deferred"));
    expect(m.events.indexOf("deferred")).toBeLessThan(m.events.indexOf("state"));
    expect(f.deferred).toHaveBeenCalledWith(
      [pending()],
      expect.objectContaining({ statelessPluginIds: ["owner"] }),
    );
    expect(f.refreshed.snapshot.sourceConfig).toBe(source);
  });
  it.each(["identity", "guard"])("publishes no deferred facts after %s refusal", async (kind) => {
    const f = fixture();
    if (kind === "identity") {
      f.refreshed.snapshot = { ...snapshot(), sourceConfig: { session: { store: "/raced.json" } } };
    } else {
      f.guard.mockResolvedValue(false);
    }
    await expect(f.run()).rejects.toThrow(
      kind === "identity" ? /inputs changed/ : /guard rejected/,
    );
    expect(f.deferred).not.toHaveBeenCalled();
    expect(f.state).not.toHaveBeenCalled();
  });
  it("refresh-only checkpoint path does not pretend to run convergence or replay state preparation", async () => {
    const f = fixture();
    f.params.converge = false;
    expect(await prepareDoctorMigrationPlugins(f.params)).toBe(f.first);
    expect(m.postCore).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.guard).not.toHaveBeenCalled();
  });
  it("rechecks the current-effect guard and lease around an awaited package effect", async () => {
    const f = fixture();
    const effect = vi.fn();
    m.postCore.mockImplementation(async (params) => {
      await params.preparePersistentEffect?.();
      params.beforePersistentEffect?.();
      effect();
      return { changes: [], warnings: [], smokeFailures: [], installRecords: {}, errored: false };
    });
    f.guard.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow(/guard rejected/);
    expect(effect).not.toHaveBeenCalled();
    expect(f.state).not.toHaveBeenCalled();
  });
  it("does not publish pending facts if custody is lost during the refreshed source guard", async () => {
    const f = fixture();
    f.guard.mockImplementation(async () => {
      f.heartbeat.mockImplementation(() => {
        throw new Error("lease revoked");
      });
      return true;
    });
    await expect(f.run()).rejects.toThrow(/lease revoked/);
    expect(f.deferred).not.toHaveBeenCalled();
    expect(f.state).not.toHaveBeenCalled();
  });
  it.each(["rehearsal", "shipped-parent"])(
    "%s verifies copied payloads without downloading and does not certify an unknown owner",
    async (mode) => {
      m.rehearsal = mode === "rehearsal";
      m.deferred = mode === "shipped-parent";
      m.inspect.mockResolvedValue({ ...inspection(), pending: [pending()] });
      const f = fixture();
      await expect(f.run()).rejects.toThrow(/owner/);
      expect(m.postCore).not.toHaveBeenCalled();
      expect(m.smoke).toHaveBeenCalledOnce();
      expect(f.state).not.toHaveBeenCalled();
      expect(m.inspect).toHaveBeenCalledWith(expect.objectContaining({ deferInstallation: true }));
    },
  );
  it("passes caller consent and effect hooks unchanged through current convergence API", async () => {
    const onCapabilityConsent = vi.fn();
    const beforePersistentEffect = vi.fn();
    const preparePersistentEffect = vi.fn();
    await runDoctorPluginConvergence({
      cfg: source,
      env: {},
      onCapabilityConsent,
      beforePersistentEffect,
      preparePersistentEffect,
    });
    expect(m.postCore).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: source,
        onCapabilityConsent,
        beforePersistentEffect,
        preparePersistentEffect,
      }),
    );
    expect(m.inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: source,
        installRecords: {
          owner: { source: "path", sourcePath: "/source/plugin", installPath: "/fresh/plugin" },
        },
      }),
    );
  });
  it("refuses capability consent failure even when the failed owner otherwise appears stateless", async () => {
    m.postCore.mockResolvedValue({
      changes: [],
      warnings: [],
      smokeFailures: [],
      installRecords: {},
      errored: true,
      outcomes: [
        { pluginId: "owner", status: "error", code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED" },
      ],
    });
    const f = fixture();
    await expect(f.run()).rejects.toThrow(/consent/i);
    expect(f.state).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
});

it.each(["requiresStateMigration", "requiresDoctorInspection"] as const)(
  "preserves retained %s refusal even when the current inspection is stateless",
  async (flag) => {
    m.inspect.mockResolvedValue({
      ...inspection(),
      statelessPluginIds: ["owner"],
      pending: [pending()],
    });
    const f = fixture();
    await expect(
      prepareDoctorMigrationPlugins({
        ...f.params,
        retainedPluginMigrations: [pending({ [flag]: true })],
      }),
    ).rejects.toThrow(/owner/);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.deferred).not.toHaveBeenCalled();
  },
);

it.each([
  {
    label: "pending plugin-owned path",
    retained: false,
    details: { configPaths: [["plugins", "entries", "owner"]] },
  },
  {
    label: "retained plugin-owned path",
    retained: true,
    details: { configPaths: [["channels", "owner"]] },
  },
  {
    label: "pending validation exclusion",
    retained: false,
    details: { validationExcludedPaths: [["channels", "owner"]] },
  },
  {
    label: "retained validation exclusion",
    retained: true,
    details: { validationExcludedPaths: [["channels", "owner"]] },
  },
])("refuses a runtime alias with $label", async ({ retained, details }) => {
  m.inspect.mockResolvedValue({
    ...inspection(),
    runtimePluginAliases: ["owner"],
    statelessPluginIds: ["canonical-owner"],
    pending: [pending(retained ? {} : details)],
  });
  const f = fixture();
  await expect(
    prepareDoctorMigrationPlugins({
      ...f.params,
      retainedPluginMigrations: retained ? [pending(details)] : [],
    }),
  ).rejects.toThrow(/owner/);
  expect(f.read).not.toHaveBeenCalled();
  expect(f.deferred).not.toHaveBeenCalled();
});
it("allows a proven runtime alias owning only the shared session locator without certifying completion", async () => {
  const shared = pending({ configPaths: [["session", "store"]] });
  m.inspect.mockResolvedValue({
    ...inspection(),
    runtimePluginAliases: ["owner"],
    statelessPluginIds: ["canonical-owner"],
    pending: [shared],
  });
  const f = fixture();
  expect(
    await prepareDoctorMigrationPlugins({ ...f.params, retainedPluginMigrations: [shared] }),
  ).toBe(f.refreshed);
  expect(f.deferred).toHaveBeenCalledWith(
    [shared],
    expect.objectContaining({ runtimePluginAliases: ["owner"] }),
  );
});

it.each([true, false])(
  "inspects retained-only owners even when current package work is required=%s",
  async (required) => {
    m.plan.mockResolvedValue({ required, installRecords: {} });
    m.inspect.mockImplementation(async (params) => ({
      ...inspection(),
      pending: params.retainedPluginIds?.includes("owner")
        ? [pending({ requiresStateMigration: true })]
        : [],
    }));
    const f = fixture();
    await expect(
      prepareDoctorMigrationPlugins({
        ...f.params,
        retainedPluginMigrations: [pending({ requiresStateMigration: true })],
      }),
    ).rejects.toThrow(/owner/);
    expect(m.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ retainedPluginIds: ["owner"] }),
    );
    expect(f.read).not.toHaveBeenCalled();
    expect(f.deferred).not.toHaveBeenCalled();
    if (!required) {
      expect(m.postCore).not.toHaveBeenCalled();
      expect(m.inspect).toHaveBeenCalledWith(
        expect.objectContaining({ verifyRetainedPayloads: true }),
      );
    }
  },
);
