import { beforeEach, expect, it, vi } from "vitest";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
const m = vi.hoisted(() => ({
  captured: undefined as
    | { onCapabilityConsent?: (request: unknown) => Promise<unknown> }
    | undefined,
  confirm: vi.fn(),
  create: vi.fn(),
  stop: new Error("preflight captured"),
}));
vi.mock("node:os", () => ({}));
vi.mock("../agents/agent-scope-config.js", () => ({}));
vi.mock("../agents/agent-scope.js", () => ({}));
vi.mock("../cli/command-format.js", () => ({}));
vi.mock("../config/agent-roster-provenance.js", () => ({}));
vi.mock("../config/io.audit.js", () => ({}));
vi.mock("../config/io.read-helpers.js", () => ({}));
vi.mock("../config/legacy.default-agent-owner.js", () => ({}));
vi.mock("../config/legacy.roster.js", () => ({}));
vi.mock("../config/mutate.js", () => ({}));
vi.mock("../config/paths.js", () => ({}));
vi.mock("../config/plugin-install-config-migration.js", () => ({}));
vi.mock("../gateway/call.js", () => ({}));
vi.mock("../plugins/installed-plugin-index-records.js", () => ({}));
vi.mock("./doctor-config-analysis.js", () => ({}));
vi.mock("./doctor-config-preflight-plugin-index.js", () => ({}));
vi.mock("./doctor/cron/store-migration.js", () => ({}));
vi.mock("./doctor/emit-notes.js", () => ({}));
vi.mock("./doctor/finalize-config-flow.js", () => ({}));
vi.mock("./doctor/shared/config-flow-steps.js", () => ({}));
vi.mock("./doctor/shared/config-migration-result.js", () => ({}));
vi.mock("./doctor/shared/config-mutation-state.js", () => ({}));
vi.mock("./doctor/shared/configured-channel-ids.js", () => ({}));
vi.mock("./doctor/shared/include-migration-ownership.js", () => ({}));
vi.mock("./doctor/shared/legacy-config-core-migrate.js", () => ({}));
vi.mock("./doctor/shared/update-phase.js", () => ({}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../cli/progress.js", () => ({
  withProgress: (_: unknown, run: (progress: unknown) => unknown) =>
    run({ done: vi.fn(), setLabel: vi.fn() }),
}));
vi.mock("./doctor-workspace-alias.js", () => ({
  createWorkspaceAliasMigrationRepair: () => undefined,
}));
vi.mock("./doctor-config-preflight.js", () => ({
  runDoctorConfigPreflight: (options: typeof m.captured) => {
    m.captured = options;
    throw m.stop;
  },
}));
vi.mock("../wizard/plugin-capability-consent.js", () => ({
  createPluginCapabilityConsentPrompter: (params: {
    confirm: (request: unknown) => Promise<unknown>;
  }) => {
    m.create(params);
    return params.confirm;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  m.captured = undefined;
});
it.each(["repair", "yes"] as const)(
  "%s carries explicit interactive consent into preflight",
  async (option) => {
    await expect(
      loadAndMaybeMigrateDoctorConfig({
        options: { [option]: true },
        confirm: vi.fn(),
        prompter: { confirmRuntimeRepair: m.confirm } as never,
      }),
    ).rejects.toBe(m.stop);
    expect(m.captured?.onCapabilityConsent).toEqual(expect.any(Function));
    m.confirm.mockResolvedValue(false);
    await expect(
      m.captured!.onCapabilityConsent!({ message: "widened capabilities", initialValue: false }),
    ).resolves.toBe(false);
    expect(m.confirm).toHaveBeenCalledWith({
      message: "widened capabilities",
      initialValue: false,
      requiresInteractiveConfirmation: true,
    });
  },
);
it("diagnostic mode never creates consent authority", async () => {
  await expect(
    loadAndMaybeMigrateDoctorConfig({
      options: {},
      confirm: vi.fn(),
      prompter: { confirmRuntimeRepair: m.confirm } as never,
    }),
  ).rejects.toBe(m.stop);
  expect(m.captured?.onCapabilityConsent).toBeUndefined();
  expect(m.create).not.toHaveBeenCalled();
});
