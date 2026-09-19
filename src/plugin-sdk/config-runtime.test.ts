/**
 * Tests config runtime exports and snapshot/cache behavior exposed through the SDK.
 */
import { describe, expect, it } from "vitest";
import { canonicalizeMainSessionAlias as canonicalizeInternalSessionKey } from "../config/sessions/main-session.js";
import {
  canonicalizeMainSessionAlias,
  getSessionEntry,
  listSessionEntries,
  readSessionUpdatedAt,
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
  type OpenClawConfig,
} from "./config-runtime.js";
import {
  canonicalizeMainSessionAlias as canonicalizeSessionStoreMainAlias,
  getSessionEntry as getSessionStoreEntry,
  listSessionEntries as listSessionStoreEntries,
  readSessionUpdatedAt as readSessionStoreUpdatedAt,
} from "./session-store-runtime.js";

describe.each([canonicalizeMainSessionAlias, canonicalizeSessionStoreMainAlias])(
  "published main-session alias boundary",
  (canonicalize) => {
    it.each(["per-sender", "global"] as const)(
      "preserves published selectors in %s scope while internal identities stay exact",
      (scope) => {
        const cfg = { session: { mainKey: "work", scope } };
        for (const sessionKey of [
          "main",
          "work",
          "agent:ops:main",
          "agent:ops:work",
          "agent:main:main",
          "agent:main:work",
        ]) {
          expect(canonicalize({ cfg, agentId: "ops", sessionKey })).toBe(
            scope === "global" ? "global" : "agent:ops:work",
          );
        }
        for (const sessionKey of [
          "agent:ops:main",
          "agent:main:main",
          "agent:research:main",
          "agent:ops:global",
          "agent:ops:unknown",
        ]) {
          expect(canonicalizeInternalSessionKey({ cfg, agentId: "ops", sessionKey })).toBe(
            sessionKey,
          );
        }
        for (const sessionKey of [
          "agent:research:main",
          "agent:ops:global",
          "agent:ops:unknown",
          "global",
          "unknown",
          "room",
          "AGENT:Ops:GLOBAL",
        ]) {
          expect(canonicalize({ cfg, agentId: "ops", sessionKey })).toBe(sessionKey);
        }
      },
    );
  },
);

describe("config-runtime session read exports", () => {
  it("re-exports the session-store runtime seam wrappers", () => {
    expect(getSessionEntry).toBe(getSessionStoreEntry);
    expect(listSessionEntries).toBe(listSessionStoreEntries);
    expect(readSessionUpdatedAt).toBe(readSessionStoreUpdatedAt);
  });
});

describe("resolvePluginConfigObject", () => {
  it("returns the plugin config object for a configured plugin entry", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: {
              enabled: false,
              mode: "strict",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "demo-plugin")).toEqual({
      enabled: false,
      mode: "strict",
    });
  });

  it("reads config through normalized plugin entry ids", () => {
    const config = {
      plugins: {
        entries: {
          " CODEX ": {
            enabled: true,
            config: { supervision: { enabled: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "codex")).toEqual({
      supervision: { enabled: true },
    });
  });

  it("returns undefined for missing or non-object plugin configs", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: "bad-shape",
          },
          "array-plugin": {
            enabled: true,
            config: ["bad-shape"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "missing-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "demo-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "array-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(undefined, "demo-plugin")).toBeUndefined();
  });
});

describe("resolveLivePluginConfigObject", () => {
  it("falls back to startup config only when no runtime loader exists", () => {
    expect(
      resolveLivePluginConfigObject(undefined, "demo-plugin", {
        enabled: true,
      }),
    ).toEqual({
      enabled: true,
    });
  });

  it("fails closed when the runtime loader exists but the plugin entry is missing", () => {
    const config = {
      plugins: {
        entries: {},
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveLivePluginConfigObject(() => config, "demo-plugin", {
        enabled: true,
      }),
    ).toBeUndefined();
  });
});
