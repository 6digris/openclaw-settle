import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { CustomEditor } from "./components/custom-editor.js";
import { makeTuiBackend } from "./tui-session-actions-test-support.js";
import { runTui } from "./tui.js";

const { ensureTool } = vi.hoisted(() => ({
  ensureTool: vi.fn<(name: string, silent: boolean) => Promise<string | undefined>>(),
}));

vi.mock("../agents/utils/tools-manager.js", () => ({ ensureTool }));
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...actual,
    ProcessTerminal: class extends actual.ProcessTerminal {
      override start() {}
      override stop() {}
      override write() {}
      override async drainInput() {}
      override get columns() {
        return 120;
      }
      override get rows() {
        return 40;
      }
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function startTui(closeOnStart = false) {
  let requestExit = () => {};
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      requestExit();
    }
  };
  const backend = Object.assign(makeTuiBackend({ start: () => closeOnStart && close() }), {
    setRequestExitHandler: (handler: () => void) => {
      requestExit = handler;
    },
  });
  const finished = runTui({
    backend,
    config: { agents: { entries: { main: { default: true } } } },
    session: "agent:main:autocomplete",
  });
  return { close, finished };
}

beforeEach(() => {
  ensureTool.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTui autocomplete lifetime", () => {
  it("does not prepare a helper after the backend closes before import completes", async () => {
    const tui = startTui(true);
    await tui.finished;
    await vi.dynamicImportSettled();

    expect(ensureTool).not.toHaveBeenCalled();
  });

  it("does not replace the closed editor provider when an accepted helper resolves", async () => {
    const helper = createDeferredCore<string>();
    ensureTool.mockReturnValue(helper.promise);
    const providers = vi.spyOn(CustomEditor.prototype, "setAutocompleteProvider");
    const tui = startTui();
    try {
      await vi.dynamicImportSettled();
      expect(ensureTool).toHaveBeenCalledWith("fd", true);
      tui.close();
      await tui.finished;
      const providerCountAtClose = providers.mock.calls.length;

      helper.resolve("/fixture/fd");
      await vi.dynamicImportSettled();

      expect(providers).toHaveBeenCalledTimes(providerCountAtClose);
    } finally {
      helper.resolve("/fixture/fd");
      tui.close();
      await tui.finished;
      await vi.dynamicImportSettled();
    }
  });

  it.each(["cached", "prepared"])(
    "keeps recursive attachment completion when the %s helper arrives while open",
    async (availability) => {
      const fdPath = join(tempDirs.make("openclaw-tui-helper-"), "fd");
      writeFileSync(fdPath, "#!/bin/sh\nprintf 'nested/needle.txt\\n'\n");
      chmodSync(fdPath, 0o755);
      const helper = createDeferredCore<string>();
      ensureTool.mockReturnValue(
        availability === "cached" ? Promise.resolve(fdPath) : helper.promise,
      );
      const providers = vi.spyOn(CustomEditor.prototype, "setAutocompleteProvider");
      const tui = startTui();
      try {
        await vi.dynamicImportSettled();
        expect(ensureTool).toHaveBeenCalledWith("fd", true);
        helper.resolve(fdPath);
        await vi.dynamicImportSettled();

        const provider = providers.mock.lastCall?.[0];
        await expect(
          provider?.getSuggestions(["@needle"], 0, 7, { signal: new AbortController().signal }),
        ).resolves.toMatchObject({
          items: [{ label: "needle.txt", value: "@nested/needle.txt" }],
          prefix: "@needle",
        });
      } finally {
        helper.resolve(fdPath);
        tui.close();
        await tui.finished;
        await vi.dynamicImportSettled();
      }
    },
  );
});
