import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, PluginStateKeyedStore } from "../api.js";
import { createVisitorAccessReader } from "./access.js";
import { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";
import { VisitorAccessService, type VisitorGrant } from "./visitors.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY_MS = 86_400_000;
const config: VisitorAccessConfig = {
  accountId: "test-account",
  appId: "test-app",
  apiToken: "test-token",
  policyName: "Visitors (openclaw-managed)",
  defaultTtlDays: 14,
  maxVisitors: 50,
};
const policiesPath = "/client/v4/accounts/test-account/access/apps/test-app/policies";
type GatewayRoles = NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
const guestRole: GatewayRoles["definitions"][string] = {
  sessions: { others: "view" },
  agents: ["main"],
  scopes: ["operator.sessions.write"],
  sandbox: "required",
};
const staffRole: GatewayRoles["definitions"][string] = {
  sessions: { others: "write" },
  agents: "*",
  scopes: ["operator.admin"],
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

type PolicyFixture = {
  id: string;
  name: string;
  decision: string;
  include: { email: { email: string } }[];
};

function visitorGrant(email: string, overrides: Partial<VisitorGrant> = {}): VisitorGrant {
  return { email, createdAt: NOW - DAY_MS, expiresAt: NOW + DAY_MS, ...overrides };
}

function visitorFixture(
  options: {
    config?: Partial<VisitorAccessConfig>;
    grants?: VisitorGrant[];
    emails?: string[];
    githubEmail?: string | null;
    gatewayConfig?: OpenClawConfig;
    profiles?: Array<{ id: string; emails: string[]; role?: string }>;
  } = {},
) {
  const resolved = { ...config, ...options.config };
  const grants = new Map(options.grants?.map((grant) => [grant.email, grant]));
  const store: PluginStateKeyedStore<VisitorGrant> = {
    async register(key, grant) {
      grants.set(key, structuredClone(grant));
    },
    async registerIfAbsent(key, grant) {
      if (grants.has(key)) {
        return false;
      }
      grants.set(key, structuredClone(grant));
      return true;
    },
    async lookup(key) {
      return structuredClone(grants.get(key));
    },
    async consume(key) {
      const grant = grants.get(key);
      grants.delete(key);
      return structuredClone(grant);
    },
    async delete(key) {
      return grants.delete(key);
    },
    async entries() {
      return [...grants].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: value.createdAt,
      }));
    },
    async clear() {
      grants.clear();
    },
  };
  const cloudflare: {
    policy: PolicyFixture | undefined;
    failWrites: boolean;
    loseWriteResponse: boolean;
    beforeWrite: () => Promise<void>;
  } = {
    policy: options.emails?.length
      ? {
          id: "visitors",
          name: resolved.policyName,
          decision: "allow",
          include: options.emails.map((email) => ({ email: { email } })),
        }
      : undefined,
    failWrites: false,
    loseWriteResponse: false,
    beforeWrite: async () => {},
  };
  const response = (result: unknown) => Response.json({ success: true, result });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (url.origin === "https://api.github.com") {
      if (!/^\/users\/[a-z0-9-]+$/.test(url.pathname) || method !== "GET") {
        throw new Error("Unexpected GitHub request");
      }
      return Response.json({ email: options.githubEmail ?? null });
    }
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith(policiesPath)) {
      throw new Error("Unexpected Cloudflare endpoint");
    }
    if (method === "GET") {
      if (url.pathname === policiesPath) {
        return response(cloudflare.policy ? [cloudflare.policy] : []);
      }
      if (url.pathname === `${policiesPath}/visitors` && cloudflare.policy) {
        return response(cloudflare.policy);
      }
      throw new Error("Unknown policy read");
    }
    await cloudflare.beforeWrite();
    if (cloudflare.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (method === "DELETE" && url.pathname === `${policiesPath}/visitors`) {
      cloudflare.policy = undefined;
    } else if (
      (method === "POST" && url.pathname === policiesPath) ||
      (method === "PUT" && url.pathname === `${policiesPath}/visitors`)
    ) {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON policy");
      }
      const body = JSON.parse(init.body) as Omit<PolicyFixture, "id">;
      cloudflare.policy = { ...body, id: "visitors" };
    } else {
      throw new Error("Unexpected policy mutation");
    }
    if (cloudflare.loseWriteResponse) {
      throw new Error("Connection lost after Cloudflare committed the policy");
    }
    return response(cloudflare.policy ?? { id: "visitors" });
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const gatewayConfig = options.gatewayConfig ?? {
    gateway: { roles: { default: "guest", definitions: { guest: guestRole, staff: staffRole } } },
  };
  const runtime: Pick<PluginRuntime, "gateway" | "config"> = {
    gateway: {
      isAvailable: async () => true,
      async request() {
        throw new Error("Expected a mocked Gateway request");
      },
    },
    config: {
      current: () => gatewayConfig,
      async mutateConfigFile() {
        throw new Error("Visitor operations must not change Gateway configuration");
      },
      async replaceConfigFile() {
        throw new Error("Visitor operations must not replace Gateway configuration");
      },
    },
  };
  const gatewayRequest = vi.spyOn(runtime.gateway, "request").mockResolvedValue({
    profiles: options.profiles ?? [],
  });
  const assertCurrent = vi.fn<() => void>();
  const service = new VisitorAccessService(
    resolved,
    store,
    new VisitorPolicyClient(resolved, fetcher),
    logger,
    createVisitorAccessReader(runtime),
    fetcher,
  );
  return {
    cloudflare,
    fetcher,
    grants,
    gatewayRequest,
    logger,
    service,
    store,
    authority: { assertCurrent },
    emails: () => cloudflare.policy?.include.map((rule) => rule.email.email) ?? [],
    mutations: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method !== "GET" && init?.method),
  };
}

describe("VisitorAccessService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves public GitHub email, records a default-expiring grant, and explains login", async () => {
    const fixture = visitorFixture({ githubEmail: "Visitor@Example.com" });

    const result = await fixture.service.invite(
      { github: "Visitor" },
      { ...fixture.authority, invitedVia: "session:maintainer" },
    );

    expect(fixture.emails()).toEqual(["visitor@example.com"]);
    expect(fixture.grants.get("visitor@example.com")).toEqual({
      email: "visitor@example.com",
      githubLogin: "visitor",
      invitedVia: "session:maintainer",
      createdAt: NOW,
      expiresAt: NOW + 14 * DAY_MS,
    });
    expect(fixture.fetcher.mock.calls[0]?.[0]).toBe("https://api.github.com/users/visitor");
    expect(result).toContain("@visitor");
    expect(result).toContain("visitor@example.com");
    expect(result).toContain("2026-09-11T12:00:00.000Z");
    expect(result).toContain("https://team.openclaw.ai");
    expect(result).toContain("Team's existing login");
    expect(result).toContain("restricted guest");
    expect(result).toContain("first sign-in pending");
    expect(fixture.gatewayRequest).toHaveBeenCalledWith(
      "users.list",
      {},
      { scopes: ["operator.read"] },
    );
  });

  it("asks for an explicit account email when GitHub has no public email, without granting access", async () => {
    const fixture = visitorFixture({ githubEmail: null });

    await expect(
      fixture.service.invite({ github: "private-visitor" }, fixture.authority),
    ).rejects.toThrow(/Ask the visitor.*Team sign-in email.*email explicitly/);

    expect(fixture.emails()).toEqual([]);
    expect(fixture.grants.size).toBe(0);
    expect(fixture.mutations()).toEqual([]);
  });

  it("uses an explicit normalized email without consulting GitHub", async () => {
    const fixture = visitorFixture();

    await fixture.service.invite(
      {
        github: "Private-Visitor",
        email: " Visitor@Example.com ",
        days: 3,
      },
      fixture.authority,
    );

    expect(fixture.grants.get("visitor@example.com")).toMatchObject({
      githubLogin: "private-visitor",
      expiresAt: NOW + 3 * DAY_MS,
    });
    expect(fixture.emails()).toEqual(["visitor@example.com"]);
    expect(
      fixture.fetcher.mock.calls.every(
        ([url]) => requestUrl(url).origin === "https://api.cloudflare.com",
      ),
    ).toBe(true);
  });

  it.each<{ reason: string; roles?: GatewayRoles }>([
    { reason: "roles are disabled" },
    { reason: "no default is configured", roles: { definitions: { guest: guestRole } } },
    {
      reason: "the default role is unknown",
      roles: { default: "missing", definitions: { guest: guestRole } },
    },
    ...[
      { reason: "sandboxing is inherited", role: { ...guestRole, sandbox: "inherit" as const } },
      {
        reason: "other sessions are writable",
        role: { ...guestRole, sessions: { others: "write" as const } },
      },
      { reason: "no agent is permitted", role: { ...guestRole, agents: [] } },
      {
        reason: "shared operator actions are allowed",
        role: { ...guestRole, scopes: [...guestRole.scopes, "operator.admin" as const] },
      },
      { reason: "own-session work is unavailable", role: { ...guestRole, scopes: [] } },
    ].map(({ reason, role }) => ({
      reason,
      roles: { default: "guest", definitions: { guest: role } },
    })),
  ])("refuses new invitations when $reason", async ({ roles }) => {
    const fixture = visitorFixture({ gatewayConfig: roles ? { gateway: { roles } } : {} });

    await expect(
      fixture.service.invite({ email: "visitor@example.com" }, fixture.authority),
    ).rejects.toThrow(/requires gateway\.roles\.default/);

    expect(fixture.grants.size).toBe(0);
    expect(fixture.mutations()).toEqual([]);
  });

  it.each([
    {
      name: "the explicitly assigned default role",
      assignedRole: "guest",
      otherRole: staffRole,
      access: 'restricted guest (assigned role "guest")',
    },
    {
      name: "a staff role",
      assignedRole: "staff",
      otherRole: staffRole,
      access: 'existing role "staff" retained; this invitation does not restrict it',
    },
    {
      name: "an independent role with guest-shaped permissions",
      assignedRole: "staff",
      otherRole: guestRole,
      access: 'existing role "staff" retained; this invitation does not restrict it',
    },
    {
      name: "the default after an assigned role was removed",
      assignedRole: "retired",
      otherRole: staffRole,
      access: 'restricted guest (default role "guest"; unavailable assignment "retired")',
    },
    {
      name: "the shared Gateway owner with a historical email alias",
      profileId: "gateway-owner",
      assignedRole: undefined,
      otherRole: staffRole,
      access: "shared owner authority retained; this invitation does not restrict it",
    },
  ])(
    "reports $name through a linked email without trusting the supplied GitHub label",
    async ({ profileId = "linked-person", assignedRole, otherRole, access }) => {
      const fixture = visitorFixture({
        profiles: [
          {
            id: profileId,
            emails: ["primary@example.com", "alias@example.com"],
            role: assignedRole,
          },
        ],
        gatewayConfig: {
          gateway: {
            roles: { default: "guest", definitions: { guest: guestRole, staff: otherRole } },
          },
        },
      });

      const result = await fixture.service.invite(
        { email: "Alias@Example.com", github: "unrelated-login", days: 1 },
        fixture.authority,
      );

      expect(result).toContain(access);
      expect(result).toContain("Visitor grant expires: 2026-08-29T12:00:00.000Z");
      expect(fixture.emails()).toEqual(["alias@example.com"]);
      vi.setSystemTime(NOW + DAY_MS);
      const list = await fixture.service.list(fixture.authority.assertCurrent);
      expect(list).toContain(
        "grant expires 2026-08-29T12:00:00.000Z | EXPIRED; provider cleanup pending",
      );
      expect(list).toContain(access);
      expect(fixture.gatewayRequest.mock.calls.every(([method]) => method === "users.list")).toBe(
        true,
      );
    },
  );

  it("does not admit or record a visitor when the Gateway access lookup fails", async () => {
    const fixture = visitorFixture();
    fixture.gatewayRequest.mockRejectedValueOnce(new Error("Profile directory unavailable"));

    await expect(
      fixture.service.invite({ email: "visitor@example.com" }, fixture.authority),
    ).rejects.toThrow("Profile directory unavailable");

    expect(fixture.grants.size).toBe(0);
    expect(fixture.mutations()).toEqual([]);
  });

  it("checks live authority again after durable recording before granting provider access", async () => {
    const fixture = visitorFixture();
    const recorded = createDeferred<void>();
    const release = createDeferred<void>();
    let current = true;
    fixture.authority.assertCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("Invitation authority is no longer current");
      }
    });
    const register = fixture.store.register;
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (key, grant) => {
      await register(key, grant);
      recorded.resolve();
      await release.promise;
    });
    const invitation = fixture.service.invite({ email: "visitor@example.com" }, fixture.authority);
    const denied = expect(invitation).rejects.toThrow(/no longer current/);
    await recorded.promise;
    current = false;
    release.resolve();

    await denied;

    expect(fixture.emails()).toEqual([]);
    expect(fixture.mutations()).toEqual([]);
    expect(fixture.grants.get("visitor@example.com")?.expiresAt).toBe(NOW + 14 * DAY_MS);
  });

  it.each([
    {},
    { email: "not-an-email" },
    { email: "a@example.com\nBcc:other@example.com" },
    { github: "../other" },
    { email: "visitor@example.com", days: 0 },
  ])("rejects invalid identity or duration before writing any grant: %j", async (input) => {
    const fixture = visitorFixture();
    await expect(fixture.service.invite(input, fixture.authority)).rejects.toBeInstanceOf(
      VisitorAccessError,
    );
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.grants.size).toBe(0);
  });

  it.each([0, null])(
    "requires explicit forever when the default duration is %s",
    async (defaultTtlDays) => {
      const fixture = visitorFixture({ config: { defaultTtlDays } });
      await expect(
        fixture.service.invite({ email: "visitor@example.com" }, fixture.authority),
      ).rejects.toThrow(/forever/);
      expect(fixture.grants.size).toBe(0);
      expect(fixture.mutations()).toEqual([]);

      const result = await fixture.service.invite(
        { email: "visitor@example.com", forever: true },
        fixture.authority,
      );
      expect(fixture.grants.get("visitor@example.com")?.expiresAt).toBeNull();
      expect(result).toContain("never");
      await expect(
        fixture.service.invite(
          { email: "visitor@example.com", forever: true, days: 1 },
          fixture.authority,
        ),
      ).rejects.toThrow(/days.*forever/);
    },
  );

  it("counts managed and unmanaged grants toward admission while allowing an existing grant to renew", async () => {
    const previous = visitorGrant("visitor@example.com", { githubLogin: "visitor" });
    const fixture = visitorFixture({
      config: { maxVisitors: 2 },
      grants: [previous],
      emails: [previous.email, "manual@example.com"],
    });
    await expect(
      fixture.service.invite({ email: "third@example.com" }, fixture.authority),
    ).rejects.toThrow(/limit/);
    expect(fixture.emails()).toEqual([previous.email, "manual@example.com"]);
    expect(fixture.grants.size).toBe(1);

    vi.setSystemTime(NOW + DAY_MS);
    const renewed = await fixture.service.invite(
      { email: "VISITOR@example.com", days: 4 },
      fixture.authority,
    );
    expect(fixture.grants.get(previous.email)).toMatchObject({
      createdAt: previous.createdAt,
      githubLogin: "visitor",
      expiresAt: NOW + 5 * DAY_MS,
    });
    expect(fixture.emails()).toEqual([previous.email, "manual@example.com"]);
    expect(fixture.grants.size).toBe(1);
    expect(renewed).toContain("Renewed");
    expect(renewed).toContain("restricted guest");

    fixture.gatewayRequest.mockResolvedValueOnce({
      profiles: [{ id: "promoted-person", emails: [previous.email], role: "staff" }],
    });
    const promoted = await fixture.service.invite(
      { email: previous.email, days: 7 },
      fixture.authority,
    );
    expect(promoted).toContain('existing role "staff" retained');
    expect(fixture.grants.get(previous.email)).toMatchObject({
      createdAt: previous.createdAt,
      expiresAt: NOW + 8 * DAY_MS,
    });
    expect(fixture.mutations()).toEqual([]);
  });

  it("revokes by recorded GitHub login even after that account hides its public email", async () => {
    const grants = ["first@example.com", "second@example.com"].map((email) =>
      visitorGrant(email, { githubLogin: "visitor" }),
    );
    const fixture = visitorFixture({
      grants,
      emails: [...grants.map((grant) => grant.email), "manual@example.com"],
    });

    const result = await fixture.service.revoke(
      { github: "Visitor" },
      fixture.authority.assertCurrent,
    );

    expect(fixture.emails()).toEqual(["manual@example.com"]);
    expect(fixture.grants.size).toBe(0);
    expect(result).toContain("@visitor (2 recorded emails)");
    expect(
      fixture.fetcher.mock.calls.every(
        ([url]) => requestUrl(url).origin !== "https://api.github.com",
      ),
    ).toBe(true);
  });

  it("explicitly revokes unmanaged emails and makes a repeated revoke a clean no-op", async () => {
    const fixture = visitorFixture({ emails: ["manual@example.com"] });
    await expect(
      fixture.service.revoke({ email: "manual@example.com" }, fixture.authority.assertCurrent),
    ).resolves.toContain("Revoked");
    expect(fixture.emails()).toEqual([]);
    expect(fixture.grants.size).toBe(0);
    const writes = fixture.mutations().length;

    await expect(
      fixture.service.revoke({ email: "manual@example.com" }, fixture.authority.assertCurrent),
    ).resolves.toMatch(/nothing to revoke/);
    expect(fixture.mutations()).toHaveLength(writes);
  });

  it("rejects an empty revoke without deleting email-only grant records", async () => {
    const grant = visitorGrant("visitor@example.com");
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });

    await expect(
      fixture.service.revoke({}, fixture.authority.assertCurrent),
    ).rejects.toBeInstanceOf(VisitorAccessError);

    expect(fixture.emails()).toEqual([grant.email]);
    expect(fixture.grants.get(grant.email)).toEqual(grant);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it("sweeps expired grants while preserving unexpired, forever, and unmanaged access", async () => {
    const expired = visitorGrant("expired@example.com", { expiresAt: NOW });
    const active = visitorGrant("active@example.com");
    const forever = visitorGrant("forever@example.com", { expiresAt: null });
    const fixture = visitorFixture({
      grants: [expired, active, forever],
      emails: [expired.email, active.email, forever.email, "manual@example.com"],
    });

    await fixture.service.sweep();

    expect(fixture.emails()).toEqual([active.email, forever.email, "manual@example.com"]);
    expect([...fixture.grants.values()]).toEqual([active, forever]);
    expect(fixture.logger.info).toHaveBeenCalledWith(expect.stringContaining(expired.email));
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/unmanaged.*manual@example.com.*retained/),
    );
  });

  it("reports both drift directions and dates without restoring or deleting dashboard changes", async () => {
    const missing = visitorGrant("missing@example.com", { githubLogin: "visitor" });
    const fixture = visitorFixture({ grants: [missing], emails: ["manual@example.com"] });

    const result = await fixture.service.list(fixture.authority.assertCurrent);
    await fixture.service.sweep();

    expect(result).toContain("1 unmanaged, 1 missing from policy");
    expect(result).toMatch(
      /missing@example.com.*@visitor.*2026-08-27T12:00:00.000Z.*2026-08-29T12:00:00.000Z.*MISSING FROM POLICY/,
    );
    expect(result).toMatch(/manual@example.com.*UNMANAGED/);
    expect(fixture.emails()).toEqual(["manual@example.com"]);
    expect(fixture.grants.get(missing.email)).toEqual(missing);
    expect(fixture.mutations()).toEqual([]);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/missing@example.com.*missing from policy/),
    );
  });

  it("bounds list output when dashboard edits exceed the visitor cap", async () => {
    const fixture = visitorFixture({
      config: { maxVisitors: 2 },
      emails: ["a@example.com", "b@example.com", "c@example.com"],
    });

    const result = await fixture.service.list(fixture.authority.assertCurrent);

    expect(result).toContain("3 unmanaged");
    expect(result.match(/UNMANAGED/g)).toHaveLength(2);
    expect(result).toContain("1 entries omitted");
    expect(fixture.emails()).toHaveLength(3);
    expect(fixture.mutations()).toEqual([]);
  });

  it.each([
    { operation: "revoke", expiresAt: NOW + DAY_MS },
    { operation: "revoke", expiresAt: null },
    { operation: "sweep", expiresAt: NOW },
  ] as const)(
    "retains ended grants after a failed Cloudflare $operation with expiry $expiresAt so cleanup can retry",
    async ({ operation, expiresAt }) => {
      const grant = visitorGrant("visitor@example.com", { expiresAt });
      const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
      fixture.cloudflare.failWrites = true;

      await expect(
        operation === "revoke"
          ? fixture.service.revoke({ email: grant.email }, fixture.authority.assertCurrent)
          : fixture.service.sweep(),
      ).rejects.toBeInstanceOf(VisitorAccessError);

      expect(fixture.grants.get(grant.email)).toEqual({ ...grant, expiresAt: NOW });
      expect(fixture.emails()).toEqual([grant.email]);
      fixture.cloudflare.failWrites = false;
      await fixture.service.sweep();
      expect(fixture.grants.size).toBe(0);
      expect(fixture.emails()).toEqual([]);
    },
  );

  it.each(["rejected", "committed but response lost"] as const)(
    "retains and reconciles a grant after its provider write is %s",
    async (outcome) => {
      const fixture = visitorFixture();
      const committed = outcome === "committed but response lost";
      fixture.cloudflare.failWrites = !committed;
      fixture.cloudflare.loseWriteResponse = committed;

      await expect(
        fixture.service.invite({ email: "visitor@example.com", days: 1 }, fixture.authority),
      ).rejects.toBeInstanceOf(VisitorAccessError);

      expect(fixture.emails()).toEqual(committed ? ["visitor@example.com"] : []);
      expect(fixture.grants.get("visitor@example.com")?.expiresAt).toBe(NOW + DAY_MS);
      const list = await fixture.service.list(fixture.authority.assertCurrent);
      expect(list).toContain(committed ? "0 missing from policy" : "1 missing from policy");
      expect(list).toContain(committed ? "| managed |" : "MISSING FROM POLICY");
      const writes = fixture.mutations().length;
      fixture.cloudflare.failWrites = false;
      fixture.cloudflare.loseWriteResponse = false;
      await expect(
        fixture.service.invite({ email: "visitor@example.com", days: 1 }, fixture.authority),
      ).resolves.toContain("Renewed");
      expect(fixture.emails()).toEqual(["visitor@example.com"]);
      expect(fixture.grants.get("visitor@example.com")?.createdAt).toBe(NOW);
      expect(fixture.mutations()).toHaveLength(writes + (committed ? 0 : 1));
      vi.setSystemTime(NOW + DAY_MS);
      await fixture.service.sweep();
      expect(fixture.grants.size).toBe(0);
      expect(fixture.emails()).toEqual([]);
    },
  );

  it("serializes concurrent invites so a delayed policy write cannot lose another visitor", async () => {
    const fixture = visitorFixture();
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.cloudflare.beforeWrite = async () => {
      writing.resolve();
      await release.promise;
    };
    const first = fixture.service.invite({ email: "first@example.com" }, fixture.authority);
    await writing.promise;
    const second = fixture.service.invite({ email: "second@example.com" }, fixture.authority);
    release.resolve();

    await Promise.all([first, second]);

    expect(fixture.emails()).toEqual(["first@example.com", "second@example.com"]);
    expect([...fixture.grants.keys()]).toEqual(["first@example.com", "second@example.com"]);
  });
});
