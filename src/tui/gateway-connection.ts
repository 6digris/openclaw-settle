import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import {
  resolveGatewayClientBootstrap,
  resolveGatewayUrlOverride,
} from "../gateway/client-bootstrap.js";
import { resolveExplicitGatewayAuth } from "../gateway/credentials.js";
import {
  gatewayEdgeAuthValueForTarget,
  normalizeEdgeAuthHeadersConfig,
  resolveEdgeAuthHeaders,
  type EdgeAuthHeadersConfig,
} from "../gateway/edge-auth.js";
import { loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readActiveGatewayLockPort } from "../infra/gateway-lock.js";

export type GatewayConnectionOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  allowConfiguredAuthForExactTarget?: boolean;
  suppressEnvAuthFallback?: boolean;
};

export type ResolvedGatewayConnection = {
  url: string;
  deviceAuthScope?: string;
  token?: string;
  password?: string;
  edgeAuthHeaders?: Readonly<Record<string, string>>;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

function throwGatewayAuthResolutionError(reason: string): never {
  throw new Error(
    [
      reason,
      "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
      "or resolve the configured secret provider for this credential.",
    ].join("\n"),
  );
}

async function hasStoredOriginDeviceAuth(deviceAuthScope: string): Promise<boolean> {
  try {
    const identity = loadDeviceIdentityIfPresent();
    return Boolean(
      identity &&
      (
        await loadOriginDeviceToken({
          gatewayScope: deviceAuthScope,
          deviceId: identity.deviceId,
          role: "operator",
        })
      )?.token,
    );
  } catch {
    return false;
  }
}

/**
 * Preserve a pre-probed Gateway route across an in-process handoff. This path
 * deliberately ignores global config and Gateway env overrides, including
 * credentials, while still applying the normal remote URL safety policy.
 */
export async function resolveBoundGatewayConnection(
  opts: GatewayConnectionOptions & { config: OpenClawConfig; url: string },
): Promise<ResolvedGatewayConnection> {
  const url = buildGatewayConnectionDetails({
    config: opts.config,
    url: opts.url,
    ignoreEnvUrlOverride: true,
  }).url;
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const edgeAuthConfig: EdgeAuthHeadersConfig | undefined = normalizeEdgeAuthHeadersConfig(
    gatewayEdgeAuthValueForTarget({ config: opts.config, targetUrl: url }),
  );
  const edgeAuthHeaders = await resolveEdgeAuthHeaders({
    config: opts.config,
    value: edgeAuthConfig,
    targetUrl: url,
    env: process.env,
  });
  return {
    url,
    deviceAuthScope: gatewayOriginScope(url),
    token: explicitAuth.token,
    password: explicitAuth.password,
    ...(edgeAuthHeaders ? { edgeAuthHeaders } : {}),
    ...(opts.tlsFingerprint ? { tlsFingerprint: opts.tlsFingerprint } : {}),
  };
}

export async function resolveGatewayConnection(
  opts: GatewayConnectionOptions,
): Promise<ResolvedGatewayConnection> {
  const config = getRuntimeConfig();
  const env = process.env;
  const gatewayAuthMode = config.gateway?.auth?.mode;
  const isRemoteMode = config.gateway?.mode === "remote";

  const urlOverride = resolveGatewayUrlOverride({ gatewayUrl: opts.url, env });
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const hasExplicitGatewayTarget = Boolean(
    urlOverride.url || env.OPENCLAW_GATEWAY_PORT?.trim() || isRemoteMode,
  );
  const resumeMayMatchLocalTarget =
    opts.allowConfiguredAuthForExactTarget === true &&
    urlOverride.source === "cli" &&
    !isRemoteMode &&
    !env.OPENCLAW_GATEWAY_PORT?.trim();
  const activeLocalGatewayPort =
    !hasExplicitGatewayTarget || resumeMayMatchLocalTarget
      ? await readActiveGatewayLockPort()
      : undefined;
  if (
    !urlOverride.source &&
    gatewayAuthMode !== "none" &&
    gatewayAuthMode !== "trusted-proxy" &&
    !isRemoteMode
  ) {
    try {
      assertExplicitGatewayAuthModeWhenBothConfigured(config);
    } catch (err) {
      throwGatewayAuthResolutionError(formatErrorMessage(err));
    }
  }
  const bootstrap = await resolveGatewayClientBootstrap({
    config,
    gatewayUrl: urlOverride.source === "cli" ? urlOverride.url : undefined,
    explicitAuth,
    env,
    authPolicy: "interactive",
    allowConfiguredAuthForExactTarget: opts.allowConfiguredAuthForExactTarget,
    suppressEnvAuthFallback: opts.suppressEnvAuthFallback,
    ...(activeLocalGatewayPort ? { localPortOverride: activeLocalGatewayPort } : {}),
    explicitTlsFingerprint: opts.tlsFingerprint,
    allowStoredOriginAuth: hasStoredOriginDeviceAuth,
    overrideAuthErrorHint:
      "Fix: pass --token or --password once to request pairing, approve it in that gateway's Control UI (Settings -> Devices), then retry with the same credential so OpenClaw can store the device token.",
    buildConnectionDetails: buildGatewayConnectionDetails,
  });
  const hasStoredOriginAuth = Boolean(
    bootstrap.deviceAuthScope && (await hasStoredOriginDeviceAuth(bootstrap.deviceAuthScope)),
  );
  const missingSharedAuth =
    bootstrap.authFailureReason === "Missing gateway auth credentials." ||
    bootstrap.authFailureReason === "Missing gateway auth token." ||
    bootstrap.authFailureReason === "Missing gateway auth password.";
  if (bootstrap.authFailureReason && (!missingSharedAuth || !hasStoredOriginAuth)) {
    throwGatewayAuthResolutionError(bootstrap.authFailureReason);
  }
  const edgeAuthConfig: EdgeAuthHeadersConfig | undefined = normalizeEdgeAuthHeadersConfig(
    gatewayEdgeAuthValueForTarget({ config, targetUrl: bootstrap.url }),
  );
  const edgeAuthHeaders = await resolveEdgeAuthHeaders({
    config,
    value: edgeAuthConfig,
    targetUrl: bootstrap.url,
    env,
  });
  return {
    url: bootstrap.url,
    deviceAuthScope: bootstrap.deviceAuthScope,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    ...(edgeAuthHeaders ? { edgeAuthHeaders } : {}),
    ...(bootstrap.tlsFingerprint ? { tlsFingerprint: bootstrap.tlsFingerprint } : {}),
  };
}
