import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  acceptSessionEventStoreTestConfig,
  captureSessionEventStoreTestConfig,
} from "../../../test/helpers/infra/session-event-store.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listAmbientGroupWatchTargets } from "../../sessions/session-state-watches.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initSessionState } from "./test/session.test-support.js";

it.each([false, true])(
  "keeps ambient watch ownership with its committed session store (replaced=%s)",
  async (replaceStore) => {
    await withOpenClawTestState(
      { label: "ambient-watch-store", layout: "state-only" },
      async (state) => {
        const restoreConfig = captureSessionEventStoreTestConfig();
        const original = state.path("original");
        const replacement = state.path("replacement");
        const alias = state.path("session-store");
        await fs.mkdir(original);
        await fs.mkdir(replacement);
        await fs.symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
        const cfg: OpenClawConfig = {
          session: {
            store: path.join(alias, "sessions.json"),
            dmScope: "per-channel-peer",
            groupScope: "per-group",
          },
        };
        const group = "agent:main:telegram:group:family";
        const committed = createDeferred();
        const release = createDeferred();
        const commit = sessionAccessor.commitReplySessionInitialization;
        const commitSpy = vi
          .spyOn(sessionAccessor, "commitReplySessionInitialization")
          .mockImplementation(async (...args) => {
            const result = await commit(...args);
            if (result.ok) {
              committed.resolve();
              await release.promise;
            }
            return result;
          });
        let initializing: ReturnType<typeof initSessionState> | undefined;
        try {
          acceptSessionEventStoreTestConfig(cfg);
          initializing = initSessionState({
            cfg,
            ctx: {
              Body: "hello group",
              ChatType: "group",
              DmScope: "per-channel-peer",
              From: "telegram:group:family",
              Provider: "telegram",
              SessionKey: group,
            },
          });
          await Promise.race([
            committed.promise,
            initializing.then(() => {
              throw new Error("Session initialization did not reach the committed pause");
            }),
          ]);
          const originalSession = sessionAccessor.loadSessionEntry({
            sessionKey: group,
            storePath: path.join(original, "sessions.json"),
          });
          expect(originalSession?.sessionId).toBeDefined();
          if (replaceStore) {
            const replacementAlias = state.path("session-store-next");
            await fs.symlink(
              replacement,
              replacementAlias,
              process.platform === "win32" ? "junction" : "dir",
            );
            await fs.rename(replacementAlias, alias);
            acceptSessionEventStoreTestConfig({ ...cfg });
          }
          release.resolve();
          const result = await initializing;

          expect(result.sessionId).toBe(originalSession?.sessionId);
          expect(
            sessionAccessor.loadSessionEntry({
              sessionKey: group,
              storePath: path.join(replacement, "sessions.json"),
            }),
          ).toBeUndefined();
          expect(listAmbientGroupWatchTargets("agent:main:main")).toEqual(
            new Set(replaceStore ? [] : [group]),
          );
        } finally {
          release.resolve();
          await Promise.allSettled([initializing]);
          commitSpy.mockRestore();
          restoreConfig();
        }
      },
    );
  },
);
