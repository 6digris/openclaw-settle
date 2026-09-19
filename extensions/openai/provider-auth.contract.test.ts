// Openai tests cover provider auth.contract plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findPersistedAuthProfileCredential } from "openclaw/plugin-sdk/agent-runtime";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { describeOpenAICodexProviderAuthContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_CODEX_DEFAULT_MODEL } from "./default-models.js";
import { createOpenAIProvider } from "./provider-contract-api.js";

const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-oauth.runtime.js", () => ({
  loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
}));

describeOpenAICodexProviderAuthContract(() => import("./index.js"), {
  expectedCodexDefaultModel: OPENAI_CODEX_DEFAULT_MODEL,
  loginOpenAICodexOAuthMock,
});

function fakeJwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

function createLegacyOpenAIManagedCredentialPair(params: { expires: number }) {
  const access = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "workspace-legacy",
      chatgpt_user_id: "user-legacy",
    },
  });
  const legacyStoredCredential = {
    type: "oauth" as const,
    provider: "openai",
    access,
    refresh: "legacy-refresh-token",
    expires: params.expires,
    accountId: "workspace-legacy",
  };
  return {
    legacyStoredCredential,
    incomingCredential: {
      ...legacyStoredCredential,
      refresh: "incoming-refresh-token",
      userId: "user-legacy",
    },
  };
}

describe("OpenAI managed auth profile matching", () => {
  it("matches a persisted legacy profile without userId using token claims", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-openai-managed-auth-"));
    const profileId = "openai:managed";
    const nativeStateDir = path.join(tempRoot, "native-openai-state");
    const nativeAgentDir = path.join(nativeStateDir, "agents", "main", "agent");
    const { incomingCredential, legacyStoredCredential } = createLegacyOpenAIManagedCredentialPair({
      expires: Date.now() + 60_000,
    });
    const method = createOpenAIProvider().auth.find((entry) => entry.id === "oauth");
    if (!method) {
      throw new Error("OpenAI OAuth method fixture missing");
    }
    expect(method.matchesPersonalAccount).toBeTypeOf("function");
    try {
      await expect(
        updateAuthProfileStoreWithLock({
          agentDir: nativeAgentDir,
          stateDir: nativeStateDir,
          sharedStoreWrite: true,
          saveOptions: {
            filterExternalAuthProfiles: false,
            syncExternalCli: false,
          },
          updater: (store) => {
            store.profiles[profileId] = legacyStoredCredential;
            return true;
          },
        }),
      ).resolves.not.toBeNull();
      expect(
        findPersistedAuthProfileCredential({
          agentDir: nativeAgentDir,
          profileId,
          stateDir: nativeStateDir,
        }),
      ).toEqual(legacyStoredCredential);

      await expect(
        updateAuthProfileStoreWithLock({
          agentDir: nativeAgentDir,
          stateDir: nativeStateDir,
          sharedStoreWrite: true,
          saveOptions: {
            filterExternalAuthProfiles: false,
            syncExternalCli: false,
          },
          updater: (store) => {
            const current = store.profiles[profileId];
            if (!current) {
              throw new Error("Seeded OpenAI profile is missing from the store");
            }
            expect(current).toEqual(legacyStoredCredential);
            expect(method.matchesPersonalAccount?.(incomingCredential, current)).toBe(true);
            store.profiles[profileId] = incomingCredential;
            return true;
          },
        }),
      ).resolves.not.toBeNull();

      expect(
        findPersistedAuthProfileCredential({
          agentDir: nativeAgentDir,
          profileId,
          stateDir: nativeStateDir,
        }),
      ).toEqual(incomingCredential);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
