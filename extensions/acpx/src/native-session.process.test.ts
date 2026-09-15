import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpxRuntime as BaseAcpxRuntime } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import type { AcpxNativeSessionInput } from "./native-types.js";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const peer = fileURLToPath(new URL("../test/fixtures/owner-agent.mjs", import.meta.url));

it("preserves native history when admission is revoked during session ensure", async () => {
  await withOpenClawTestState({ label: "acpx-native-cancel-resume" }, async (state) => {
    const peerDirectory = path.join(state.root, "peer");
    await fs.mkdir(peerDirectory);
    const command = [process.execPath, peer, peerDirectory];
    const runtime = new AcpxRuntime({
      cwd: state.root,
      sessionStore: createFileSessionStore({ stateDir: state.root }),
      agentRegistry: createAgentRegistry({ overrides: { fixture: command } }),
      permissionMode: "deny-all",
      timeoutMs: 5_000,
    });
    const input: AcpxNativeSessionInput = {
      agentId: "main",
      sessionId: "conversation",
      sessionKey: "agent:main:chat",
      agent: "fixture",
      command,
      cwd: state.root,
      assertActive() {},
      onPermissionRequest: async () => ({ outcome: "cancel" }),
    };
    const prompt = (text: string) =>
      runtime.native.withSession(
        input,
        async ({ runtime: sessionRuntime, handle, lastRequestId }) => {
          const turn = sessionRuntime.startTurn({ handle, text, requestId: text, mode: "prompt" });
          const chunks: string[] = [];
          for await (const event of turn.events) {
            if (event.type === "text_delta") {
              chunks.push(event.text);
            }
          }
          expect(await turn.result).toMatchObject({ status: "completed" });
          return {
            backendSessionId: handle.backendSessionId,
            lastRequestId,
            reply: JSON.parse(chunks.join("")),
          };
        },
      );
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const ensureSpy = vi.spyOn(BaseAcpxRuntime.prototype, "ensureSession");
    let cancelled: Promise<unknown> | undefined;
    try {
      const first = await prompt("previous-input");
      expect(first.reply).toMatchObject({ history: ["previous-input"] });
      ensureSpy.mockImplementationOnce(async function (this: BaseAcpxRuntime, params) {
        ensureSpy.mockRestore();
        const handle = await this.ensureSession(params);
        entered.resolve();
        await release.promise;
        return handle;
      });
      let active = true;
      const submit = vi.fn();
      cancelled = runtime.native.withSession(
        {
          ...input,
          assertActive() {
            if (!active) {
              throw new Error("admission revoked");
            }
          },
        },
        submit,
      );
      const rejected = expect(cancelled).rejects.toThrow("admission revoked");
      await Promise.race([entered.promise, cancelled]);
      active = false;
      release.resolve();
      await rejected;
      expect(submit).not.toHaveBeenCalled();
      ensureSpy.mockRestore();

      const resumed = await prompt("next-input");
      expect(resumed).toMatchObject({
        backendSessionId: first.backendSessionId,
        lastRequestId: "previous-input",
        reply: { history: ["previous-input", "next-input"] },
      });

      await runtime.native.closeSession(input, () => {});
      const reset = await prompt("after-reset");
      expect(reset.backendSessionId).not.toBe(first.backendSessionId);
      expect(reset.lastRequestId).toBeUndefined();
      expect(reset.reply).toMatchObject({ history: ["after-reset"] });
    } finally {
      release.resolve();
      await Promise.allSettled([cancelled]);
      ensureSpy.mockRestore();
      await runtime.native.closeSession(input, () => {});
    }
  });
});
