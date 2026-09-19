import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { mocks } from "./doctor-health.test-support.js";

export function registerDoctorWindowsLauncherTests(
  runDoctorHealthFlow: (typeof import("./doctor-health.js"))["runDoctorHealthFlow"],
) {
  it.each([
    { options: { nonInteractive: true }, shouldRepair: false },
    { options: { repair: true, nonInteractive: true }, shouldRepair: true },
    { options: { yes: true, nonInteractive: true }, shouldRepair: true },
  ])(
    "runs Windows launcher inspection with the Doctor repair policy: $options",
    async ({ options, shouldRepair }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const root = state.path("source-checkout");
        mocks.packageRoot.mockReturnValue(root);
        mocks.service.mockReturnValue({
          readCommand: async () => null,
          readRuntime: async () => ({ status: "stopped" }),
          isLoaded: async () => false,
          isEnabled: async () => false,
        });
        mocks.runContributions.mockImplementation(async () => {
          expect(mocks.repairWindowsGitLauncher).toHaveBeenCalledExactlyOnceWith(
            root,
            shouldRepair,
          );
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, options);
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        expect(mocks.repairWindowsGitLauncher).toHaveBeenCalledExactlyOnceWith(root, shouldRepair);
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );

  it("propagates launcher repair failure before contributions and success output", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      mocks.packageRoot.mockReturnValue(state.path("source-checkout"));
      mocks.service.mockReturnValue({
        readCommand: async () => null,
        readRuntime: async () => ({ status: "stopped" }),
        isLoaded: async () => false,
        isEnabled: async () => false,
      });
      const failure = new Error("launcher replacement failed");
      mocks.repairWindowsGitLauncher.mockRejectedValueOnce(failure);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await expect(
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
      ).rejects.toBe(failure);
      expect(mocks.runContributions).not.toHaveBeenCalled();
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    });
  });
}
