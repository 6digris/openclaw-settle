import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  publishSystemEventStoreConfig,
  resolveSessionStorePathForScope,
} from "../config/sessions/session-store-path.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import {
  getPublishedSystemEventStoreSelection,
  publishSystemEventStoreSelection,
} from "../infra/system-event-ownership.js";
import {
  drainSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "../infra/system-events.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentExecCommand } from "./agent-exec.js";
import { agentCliCommand } from "./agent-via-gateway.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const agent = vi.hoisted(() => vi.fn());
vi.mock("./agent.js", () => ({ agentCommand: agent }));

it.each(
  (["local", "exec"] as const).flatMap((host) =>
    [false, true].flatMap((previous) => [false, true].map((fails) => ({ host, previous, fails }))),
  ),
)(
  "owns $host notification admission and restores prior selection (previous=$previous, fails=$fails)",
  async ({ host, previous, fails }) => {
    const originalSelection = getPublishedSystemEventStoreSelection();
    try {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        });
        if (previous) {
          publishSystemEventStoreConfig({ session: { store: state.statePath("previous.sqlite") } });
        } else {
          publishSystemEventStoreSelection(undefined);
        }
        const previousSelection = getPublishedSystemEventStoreSelection();
        const sessionKey = "agent:main:notification-host";
        const failure = new Error("synthetic agent failure");
        let observed:
          | {
              accepted: boolean;
              storePath: string | null | undefined;
              expectedStorePath: string;
              stateDir: string | undefined;
            }
          | undefined;
        agent.mockReset().mockImplementation(async () => {
          const cfg = getRuntimeConfigSnapshot() ?? undefined;
          const expectedStorePath = resolveIdentityPathViaExistingAncestorSync(
            resolveSqliteTargetFromSessionStorePath(
              resolveSessionStorePathForScope({ agentId: "main", sessionKey }, cfg),
              { agentId: "main" },
            ).path,
          );
          const accepted = enqueueSystemEvent("Exec completed (host-proof, code 0) :: done", {
            sessionKey,
            contextKey: "exec:host-proof",
          });
          observed = {
            accepted,
            storePath: peekSystemEventEntries(sessionKey)[0]?.sessionStorePath,
            expectedStorePath,
            stateDir: process.env.OPENCLAW_STATE_DIR,
          };
          if (fails) {
            throw failure;
          }
          return {
            payloads: [{ text: "done" }],
            meta: { durationMs: 1, finalAssistantVisibleText: "done" },
          };
        });
        try {
          if (host === "local") {
            const result = agentCliCommand(
              { message: "inspect", agent: "main", sessionKey, local: true },
              createTestRuntime(),
            );
            if (fails) {
              await expect(result).rejects.toThrow("synthetic agent failure");
            } else {
              await result;
            }
          } else {
            const result = await agentExecCommand(
              "inspect",
              { isolated: true, authEnvOnly: true },
              createTestRuntime(),
              { baseConfig: {}, runAgent: agent },
            );
            expect(result.envelope.ok).toBe(!fails);
          }
          expect(agent).toHaveBeenCalledOnce();
          expect(observed?.accepted).toBe(true);
          expect(observed?.storePath).toBe(observed?.expectedStorePath);
          expect(getPublishedSystemEventStoreSelection()).toBe(previousSelection);
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          if (host === "exec") {
            expect(observed?.stateDir).not.toBe(state.stateDir);
            await expect(
              fs.access(expectDefined(observed?.stateDir, "exec state directory")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
        } finally {
          drainSystemEventEntries(sessionKey);
          publishSystemEventStoreSelection(undefined);
          agent.mockReset();
        }
      });
    } finally {
      publishSystemEventStoreSelection(originalSelection);
    }
  },
);
