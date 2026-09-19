// @vitest-environment node
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionsPatchResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { SessionToolOverrides } from "./patch.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

const key = "agent:main:tool-overrides";
const initial: GatewaySessionRow = {
  key,
  kind: "direct",
  sessionId: "original",
  updatedAt: 1,
  toolOverrides: { skills: { previous: false } },
};

it.each([
  { patch: { skills: { release: false } }, confirmed: { skills: { release: false } } },
  { patch: null, confirmed: undefined },
  { patch: {}, confirmed: undefined },
])(
  "retains acknowledged tool overrides $patch when the roster refresh fails",
  async ({ patch, confirmed }) => {
    let lists = 0;
    const client = createTestGatewayClient(async (method) => {
      if (method === "sessions.patch") {
        return {
          ok: true,
          path: "(sessions)",
          key,
          entry: {
            sessionId: "original",
            updatedAt: 2,
            ...(confirmed ? { toolOverrides: confirmed } : {}),
          },
        };
      }
      if (method === "sessions.list") {
        if (++lists === 1) {
          return sessionsResult([initial], 1);
        }
        throw new Error("Roster refresh unavailable");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    try {
      await sessions.refresh({ force: true });
      const result = await sessions.patch(
        key,
        { toolOverrides: patch },
        { expectedSessionId: "original" },
      );
      expect(result).toMatchObject({ listRefreshError: "Roster refresh unavailable" });
      expect(sessions.state.result?.sessions[0]?.toolOverrides).toEqual(confirmed);
      expect(lists).toBe(2);
    } finally {
      sessions.dispose();
    }
  },
);

it.each(["rejected", "wrong-incarnation", "newer-row"])(
  "does not project tool override facts from a %s receipt",
  async (scenario) => {
    let lists = 0;
    const response = createDeferred<SessionsPatchResult>();
    const next: SessionToolOverrides = { skills: { release: false } };
    const client = createTestGatewayClient(async (method) => {
      if (method === "sessions.patch") {
        return response.promise;
      }
      if (method === "sessions.list") {
        if (++lists === 1) {
          return sessionsResult([initial], 1);
        }
        if (scenario === "newer-row" && lists === 2) {
          return sessionsResult(
            [{ ...initial, updatedAt: 3, toolOverrides: { skills: { external: false } } }],
            3,
          );
        }
        throw new Error("Roster refresh unavailable");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);
    try {
      await sessions.refresh({ force: true });
      const pending = sessions.patch(
        key,
        { toolOverrides: next },
        { expectedSessionId: "original" },
      );
      if (scenario === "rejected") {
        const rejected = expect(pending).rejects.toThrow("Rejected write");
        response.reject(new Error("Rejected write"));
        await rejected;
      } else {
        if (scenario === "newer-row") {
          await sessions.refresh({ force: true });
          expect(sessions.state.result?.sessions[0]?.toolOverrides).toEqual({
            skills: { external: false },
          });
        }
        response.resolve({
          ok: true,
          path: "(sessions)",
          key,
          entry: {
            sessionId: scenario === "wrong-incarnation" ? "replacement" : "original",
            updatedAt: 2,
            toolOverrides: next,
          },
        });
        await pending;
      }
      expect(sessions.state.result?.sessions[0]?.toolOverrides).toEqual(
        scenario === "newer-row" ? { skills: { external: false } } : initial.toolOverrides,
      );
    } finally {
      sessions.dispose();
    }
  },
);
