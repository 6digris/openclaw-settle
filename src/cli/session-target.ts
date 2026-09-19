import { normalizeAgentSessionKeyParts } from "@openclaw/session-url-contract";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { classifyGatewayConnectFailure } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type {
  AgentsListResult,
  ChatHistoryParams,
  HelloOk,
  SessionsResolveResult,
} from "../../packages/gateway-protocol/src/index.js";
import { visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isAbortRequestText } from "../auto-reply/reply/abort-primitives.js";
import { formatTextCell } from "../commands/text-format.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  callGateway,
  GatewayStoredDeviceAuthUnavailableError,
  GatewayTransportError,
} from "../gateway/call.js";
import { sanitizeChatSendMessageInput } from "../gateway/chat-input-sanitize.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { projectGatewayUrlForDiagnostics } from "../gateway/connection-details.js";
import { normalizeAgentIdStrict, parseAgentSessionKey } from "../routing/session-key.js";
import {
  parseSessionTargetInput,
  SessionTargetParseError,
  type SessionTargetInput,
} from "./session-ref.js";

export type SessionTargetGateway = {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type ResolvedSessionTarget = {
  sessionKey: string;
  gateway: SessionTargetGateway;
  parsed: SessionTargetInput;
};

function gatewayUrlForTarget(target: SessionTargetInput): string | undefined {
  return target.kind === "url" ? `${target.origin}${target.basePath}` : undefined;
}

export async function callSessionTargetGateway<T>(params: {
  gateway: SessionTargetGateway;
  method: string;
  request?: unknown;
  requiredScope: "operator.read" | "operator.admin";
  shortRef?: boolean;
  onHelloOk?: (hello: HelloOk) => void;
  requiredCapabilities?: string[];
}): Promise<T> {
  const explicitUrl = params.gateway.url?.trim() || undefined;
  try {
    return await callGateway<T>({
      config: params.gateway.config,
      url: explicitUrl,
      token: params.gateway.token,
      password: params.gateway.password,
      tlsFingerprint: params.gateway.tlsFingerprint,
      method: params.method,
      params: params.request,
      mode: GATEWAY_CLIENT_MODES.CLI,
      caps: [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      onHelloOk: params.onHelloOk,
      requiredCapabilities: params.requiredCapabilities,
      ...(explicitUrl
        ? {
            useStoredDeviceAuth: true,
            requiredStoredDeviceAuthScopes: [params.requiredScope],
          }
        : {}),
    });
  } catch (error) {
    throw shapeTargetError(error, explicitUrl, params.shortRef === true);
  }
}

export type SessionWireHistory = {
  sessionKey?: string;
  sessionId?: string;
  sessionInfo?: { key?: string; agentId?: string; activeLeafEntryId?: string | null };
};

/** Preserve the recorded physical identity while adapting published session-key formats. */
export async function resolveSessionWireTarget<History extends SessionWireHistory>(params: {
  sessionKey?: string;
  agentId?: string;
  targetIntent?: "home" | "exact";
  sendMessage?: string;
  canonicalSessionKeys: boolean;
  readHistory: (request: ChatHistoryParams) => Promise<History>;
}): Promise<{
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  activeLeafEntryId?: string | null;
  legacyMain?: boolean;
  legacyGlobal?: boolean;
  history?: History;
}> {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed || !["main", "global", "unknown"].includes(parsed.rest)) {
    return { sessionKey: params.sessionKey, agentId: params.agentId };
  }
  const explicitOwner =
    params.agentId === undefined ? null : normalizeAgentIdStrict(params.agentId);
  if (explicitOwner && (!explicitOwner.ok || explicitOwner.value !== parsed.agentId)) {
    throw new Error("Session key does not match the selected agent.");
  }
  const qualifiedKey = `agent:${parsed.agentId}:${parsed.rest}`;
  if (params.canonicalSessionKeys) {
    return { sessionKey: qualifiedKey, agentId: params.agentId };
  }
  const history = (sessionKey: string) =>
    params.readHistory({ sessionKey, agentId: parsed.agentId, limit: 1 });
  const rejectCollision = (qualified: SessionWireHistory, legacy: SessionWireHistory) => {
    if (qualified.sessionId && legacy.sessionId && qualified.sessionId !== legacy.sessionId) {
      throw new Error(
        "Gateway has distinct qualified and legacy sessions for this identity. Update and repair the Gateway before selecting it.",
      );
    }
  };
  if (params.targetIntent === "home") {
    const home = await history("main");
    if (home.sessionInfo?.key === "global") {
      rejectCollision(await history(`agent:${parsed.agentId}:global`), home);
    }
    return { sessionKey: "main", agentId: parsed.agentId, history: home };
  }
  const exact = await history(qualifiedKey);
  if (exact.sessionInfo?.key !== qualifiedKey) {
    throw new Error("Gateway resolved the session to a different conversation.");
  }
  if (parsed.rest === "main") {
    return {
      sessionKey: qualifiedKey,
      agentId: parsed.agentId,
      sessionId: exact.sessionId,
      legacyMain: true,
      history: exact,
    };
  }
  let legacy: History;
  try {
    legacy = await history(parsed.rest);
  } catch (error) {
    if (
      !(error instanceof GatewayClientRequestError) ||
      error.gatewayCode !== "INVALID_REQUEST" ||
      exact.sessionInfo.agentId !== parsed.agentId ||
      !error.message.startsWith(`agent "${parsed.agentId}" does not match session key agent "`)
    ) {
      throw error;
    }
    // Published fixed stores can assign the raw alias to a different owner.
    const raw = await params.readHistory({ sessionKey: parsed.rest, limit: 1 });
    const owner = normalizeAgentIdStrict(raw.sessionInfo?.agentId);
    if (
      raw.sessionInfo?.key !== parsed.rest ||
      !owner.ok ||
      owner.value !== raw.sessionInfo.agentId ||
      owner.value === parsed.agentId ||
      error.message !==
        `agent "${parsed.agentId}" does not match session key agent "${owner.value}"`
    ) {
      throw error;
    }
    return {
      sessionKey: qualifiedKey,
      agentId: parsed.agentId,
      sessionId: exact.sessionId,
      history: exact,
    };
  }
  if (legacy.sessionInfo?.key !== parsed.rest) {
    throw new Error("Gateway resolved the session to a different conversation.");
  }
  rejectCollision(exact, legacy);
  if (exact.sessionId || !legacy.sessionId) {
    return {
      sessionKey: qualifiedKey,
      agentId: parsed.agentId,
      sessionId: exact.sessionId,
      history: exact,
    };
  }
  if (parsed.rest === "global" && params.sendMessage !== undefined) {
    const message = sanitizeChatSendMessageInput(params.sendMessage);
    // Published peers stop work before checking the captured session and leaf.
    if (message.ok && isAbortRequestText(message.message)) {
      throw new Error(
        "Update this Gateway to stop this exact legacy global session, or select Home.",
      );
    }
  }
  return {
    sessionKey: parsed.rest,
    agentId: parsed.agentId,
    sessionId: legacy.sessionId,
    activeLeafEntryId: legacy.sessionInfo?.activeLeafEntryId,
    legacyGlobal: parsed.rest === "global",
    history: legacy,
  };
}

export async function resolveLegacySessionRoutingFacts(
  snapshot: {
    valid: boolean;
    runtimeConfig: OpenClawConfig;
    configRevisionHash?: string;
    appliedConfigHash?: string | null;
  },
  agents: AgentsListResult,
) {
  const cfg = snapshot.runtimeConfig;
  if (
    !snapshot.valid ||
    !snapshot.appliedConfigHash ||
    snapshot.appliedConfigHash !== snapshot.configRevisionHash ||
    (cfg.session?.scope ?? "per-sender") !== agents.scope
  ) {
    throw new Error("Gateway routing is not ready for an exact session send. Refresh and retry.");
  }
  const owner = normalizeAgentIdStrict(agents.defaultId);
  if (!owner.ok || !["sole", "legacy", "explicit"].includes(agents.ownership ?? "")) {
    throw new Error("Gateway did not provide the owner needed to protect this exact session.");
  }
  const [{ retainLegacyDefaultAgentId }, { resolveSessionRoutingContract }] = await Promise.all([
    import("../config/legacy.default-agent-owner.js"),
    import("../config/sessions/main-session.js"),
  ]);
  // Published config snapshots omit the retained owner; agents.list supplies that same owner's fact.
  const routingConfig = retainLegacyDefaultAgentId(
    { ...cfg },
    agents.ownership === "explicit" ? undefined : owner.value,
  );
  return {
    scope: cfg.session?.scope ?? "per-sender",
    contract: resolveSessionRoutingContract(routingConfig),
  };
}

function candidateId(key: string): string {
  const uuid = key.match(/([0-9a-f]{8}-[0-9a-f-]{27})$/iu)?.[1]?.replaceAll("-", "");
  return (uuid ?? key).slice(0, 16);
}

function formatAmbiguousCandidates(
  candidates: Array<{ key: string; displayName?: string }>,
  gatewayUrl: string | undefined,
): string {
  const rows = candidates.map((candidate) => ({
    name: sanitizeTerminalText(candidate.displayName?.trim() || "(unnamed)").replace(/\s+/gu, " "),
    id: candidateId(candidate.key),
  }));
  const nameWidth = Math.max(...rows.map((row) => visibleWidth(row.name)));
  const width = Math.max("SESSION".length, Math.min(40, nameWidth));
  return [
    "Session reference is ambiguous:",
    `${"SESSION".padEnd(width)}  ID PREFIX`,
    ...rows.map((row) => `${formatTextCell(row.name, width)}  ${row.id}`),
    `Pass a longer reference. ${sessionsListHint(gatewayUrl)}`,
  ].join("\n");
}

function sessionsListHint(gatewayUrl: string | undefined): string {
  return gatewayUrl
    ? `Choose a full session key from that gateway's Control UI (${controlUiBaseUrl(gatewayUrl)}).`
    : "Run `openclaw sessions list` to choose a full session key.";
}

function controlUiBaseUrl(gatewayUrl: string): string {
  const url = new URL(gatewayUrl);
  url.protocol =
    url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  return sanitizeTerminalText(url.toString().replace(/\/$/u, ""));
}

function isPriorGatewayShortIdRejection(error: unknown): boolean {
  return (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("invalid sessions.resolve params:") &&
    error.message.includes("unexpected property 'shortId'")
  );
}

function unreachableTargetError(error: Error, gatewayUrl: string | undefined): Error {
  if (!gatewayUrl) {
    return error;
  }
  const hostname = new URL(gatewayUrl).hostname;
  const displayGatewayUrl = projectGatewayUrlForDiagnostics(gatewayUrl);
  const tailscaleHint = hostname.endsWith(".ts.net")
    ? " For this .ts.net host, check that Tailscale is connected and the gateway is reachable on your tailnet."
    : "";
  return new Error(
    `${error.message}\nCould not reach gateway ${displayGatewayUrl}. Check whether the gateway is down and whether its tailnet or SSH tunnel is reachable.${tailscaleHint}`,
  );
}

function shapeTargetError(
  error: unknown,
  gatewayUrl: string | undefined,
  shortRef: boolean,
): Error {
  if (shortRef && isPriorGatewayShortIdRejection(error)) {
    return new Error(
      `This gateway predates short-link resolution; pass the full session key. ${sessionsListHint(gatewayUrl)}`,
    );
  }
  if (error instanceof GatewayStoredDeviceAuthUnavailableError && gatewayUrl) {
    return new Error(
      `No stored device auth for ${gatewayUrl}. Pass --token or --password once, approve the pairing request in that gateway's Control UI (Settings > Devices), then retry.`,
    );
  }
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  // A pin mismatch names the precise trust failure and must never be reclassified as transport.
  if (/tls fingerprint/iu.test(error.message)) {
    return error;
  }
  if (
    error instanceof GatewayClientRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("No session found")
  ) {
    return new Error(`${error.message}\n${sessionsListHint(gatewayUrl)}`);
  }
  const failure = classifyGatewayConnectFailure({
    ...(error instanceof GatewayClientRequestError ? { details: error.details } : {}),
    ...(error instanceof GatewayTransportError ? { reason: error.reason } : {}),
    message: error.message,
  });
  if (failure.kind === "identity-proxy") {
    return new Error(`${failure.userMessage}\n${failure.remediation}`);
  }
  if (failure.kind === "unreachable") {
    const effectiveGatewayUrl =
      gatewayUrl ??
      (error instanceof GatewayTransportError ? error.connectionDetails.url : undefined);
    return unreachableTargetError(error, effectiveGatewayUrl);
  }
  return failure.remediation ? new Error(`${failure.userMessage}\n${failure.remediation}`) : error;
}

export async function resolveSessionTarget(params: {
  raw: string;
  gateway?: SessionTargetGateway;
  requiredScope?: "operator.read" | "operator.admin";
}): Promise<ResolvedSessionTarget> {
  const parsed = parseSessionTargetInput(params.raw);
  const targetUrl = gatewayUrlForTarget(parsed);
  if (targetUrl && params.gateway?.url) {
    throw new Error("pass one target: use either the session URL or --url, not both");
  }
  const gateway: SessionTargetGateway = {
    ...params.gateway,
    url: targetUrl ?? params.gateway?.url,
  };
  if (parsed.ref.kind === "main") {
    if (parsed.kind !== "url") {
      throw new SessionTargetParseError();
    }
    const agents = await callSessionTargetGateway<AgentsListResult>({
      gateway,
      method: "agents.list",
      request: {},
      requiredScope: params.requiredScope ?? "operator.read",
    });
    return {
      parsed,
      gateway,
      sessionKey: resolveCanonicalMainSessionKey({
        agentId: parsed.agentId,
        mainKey: agents.mainKey,
        sessionScope: agents.scope,
      }),
    };
  }

  const ref = parsed.ref;
  const request =
    ref.kind === "short"
      ? {
          shortId: ref.shortId,
          ...(ref.slugHint ? { slugHint: ref.slugHint } : {}),
        }
      : { key: ref.sessionKey };
  const result = await callSessionTargetGateway<SessionsResolveResult>({
    gateway,
    method: "sessions.resolve",
    request,
    requiredScope: params.requiredScope ?? "operator.read",
    shortRef: ref.kind === "short",
  });
  if (result.ok) {
    const owner = normalizeAgentIdStrict(result.agentId);
    const resolved = normalizeAgentSessionKeyParts(result.key);
    const sessionKey = resolved.ok
      ? resolved.value.sessionKey
      : owner.ok && (result.key === "global" || result.key === "unknown")
        ? `agent:${owner.value}:${result.key}`
        : undefined;
    if (
      !owner.ok ||
      !sessionKey ||
      (resolved.ok && resolved.value.agentId !== owner.value) ||
      (ref.kind === "literal" && ref.sessionKey !== sessionKey)
    ) {
      throw new Error("Gateway resolved the session to a different conversation.");
    }
    return { parsed, gateway, sessionKey };
  }
  if (result.candidates?.length) {
    throw new Error(formatAmbiguousCandidates(result.candidates, gateway.url));
  }
  throw new Error(`No session found.\n${sessionsListHint(gateway.url)}`);
}
