// Provider-resolution test helpers own reusable managed auth fixtures.

function fakeJwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

export function createLegacyOpenAIManagedCredentialPair(params: { expires: number }) {
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
