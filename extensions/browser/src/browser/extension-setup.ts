import os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import {
  browserExtensionStatus,
  installChromeExtensionBootstrap,
  type BrowserExtensionStatus,
} from "./extension-install.js";

type BrowserExtensionSetupAction = "inspect" | "install" | "verify";
export type BrowserExtensionSetupResult = {
  action: BrowserExtensionSetupAction;
  target: {
    kind: "local-host";
    platform: NodeJS.Platform;
    hostname: string;
    profile: string;
    relayPort: number;
  };
  phase:
    | "inspection_required"
    | "preparing"
    | "needs_browser_action"
    | "waiting_for_connection"
    | "ready"
    | "blocked";
  reason:
    | "native_host_missing"
    | "native_host_unavailable"
    | "platform_unsupported"
    | "chrome_approval_required"
    | "extension_missing"
    | "connection_unchecked"
    | "relay_unavailable"
    | "extension_disconnected"
    | "connected";
  installation: {
    nativeHostRegistered: boolean;
    installRequested: boolean;
    discoveredProfiles: number;
    awaitingApproval: boolean;
    automaticBootstrapSupported: boolean;
  };
  connection: {
    state: "not_checked" | "unavailable" | "waiting_for_extension" | "connected";
    extensionVersion?: string;
  };
  nextAction:
    | "none"
    | "install"
    | "open_chrome"
    | "approve_extension"
    | "install_from_store"
    | "check_connection"
    | "repair_native_host"
    | "unsupported";
};

type SetupOptions = {
  action: BrowserExtensionSetupAction;
  bundledDir: string;
  pluginRoot: string;
  cfg: OpenClawConfig;
  profile?: string;
  waitMs?: number;
  requestStoreInstall?: boolean;
  nativeHostExecutable?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
};

/** Filesystem setup has one owner; callers retain their documented output projections. */
export async function observeBrowserExtensionSetup(
  options: Pick<
    SetupOptions,
    | "action"
    | "bundledDir"
    | "pluginRoot"
    | "waitMs"
    | "requestStoreInstall"
    | "signal"
    | "onProgress"
    | "profile"
    | "nativeHostExecutable"
  >,
): Promise<BrowserExtensionStatus> {
  options.signal?.throwIfAborted();
  return options.action === "install"
    ? installChromeExtensionBootstrap({ ...options, browserProfile: options.profile })
    : browserExtensionStatus({
        bundledDir: options.bundledDir,
        pluginRoot: options.pluginRoot,
        browserProfile: options.profile,
        nativeHostExecutable: options.nativeHostExecutable,
        signal: options.signal,
      });
}

/** Native bootstrap, not the UI, transfers the host-local key to the origin-locked extension. */
export async function runBrowserExtensionSetup(
  options: SetupOptions,
): Promise<BrowserExtensionSetupResult> {
  // Capture the exact host profile before any install effect. Never use Gateway auto-routing.
  const resolved = resolveBrowserConfig(options.cfg.browser, options.cfg);
  const profileName = options.profile ?? "chrome";
  const profile = resolveProfile(resolved, profileName);
  if (!profile || profile.driver !== "extension") {
    throw new Error("Chrome setup requires an existing extension browser profile");
  }
  const relayPort =
    profile.cdpPort ??
    resolved.extensionRelayPorts[profileName] ??
    resolved.extensionRelayDefaultPort;
  const status = await observeBrowserExtensionSetup({ ...options, profile: profileName });
  options.signal?.throwIfAborted();
  const healthyProducts = new Set(
    status.registrations
      .filter((entry) => entry.state === "owned" && !entry.issue)
      .map((entry) => entry.product),
  );
  const discoveredProducts = [...status.discovered, ...status.storeDiscovered].map(
    (entry) => entry.product,
  );
  const nativeHostRegistered =
    healthyProducts.size > 0 && discoveredProducts.every((product) => healthyProducts.has(product));
  const unavailable = status.registrations.some(
    (entry) => entry.state === "foreign" || entry.state === "invalid" || Boolean(entry.issue),
  );
  const installation = {
    nativeHostRegistered,
    installRequested: status.storeInstallRequests.some((entry) => entry.state === "requested"),
    discoveredProfiles:
      status.discovered.length + status.storeDiscovered.filter((entry) => entry.enabled).length,
    awaitingApproval: status.storeDiscovered.some((entry) => entry.awaitingApproval),
    automaticBootstrapSupported: status.platformSupport === "automatic",
  };
  const result: BrowserExtensionSetupResult = {
    action: options.action,
    target: {
      kind: "local-host",
      platform: status.platform,
      hostname: os.hostname(),
      profile: profileName,
      relayPort,
    },
    phase: "waiting_for_connection",
    reason: "connection_unchecked",
    installation,
    connection: { state: "not_checked" },
    nextAction: "check_connection",
  };
  if (!installation.automaticBootstrapSupported) {
    Object.assign(result, {
      phase: "blocked",
      reason: "platform_unsupported",
      nextAction: "unsupported",
    });
  } else if (!nativeHostRegistered) {
    Object.assign(result, {
      phase: unavailable ? "blocked" : "inspection_required",
      reason: unavailable ? "native_host_unavailable" : "native_host_missing",
      nextAction: unavailable ? "repair_native_host" : "install",
    });
  } else if (!installation.discoveredProfiles) {
    Object.assign(result, {
      phase: "needs_browser_action",
      reason: installation.awaitingApproval ? "chrome_approval_required" : "extension_missing",
      nextAction: installation.awaitingApproval
        ? "approve_extension"
        : installation.installRequested
          ? "open_chrome"
          : "install_from_store",
    });
  }
  return options.action === "verify" ? verifyBrowserExtensionSetup(result, options.signal) : result;
}

async function verifyBrowserExtensionSetup(
  result: BrowserExtensionSetupResult,
  signal?: AbortSignal,
): Promise<BrowserExtensionSetupResult> {
  // Read-only, exact profile/port proof; no key creation, relay start, or remote Gateway.
  try {
    const { readExtensionRelayToken } = await import("./extension-relay/relay-auth.js");
    const token = readExtensionRelayToken();
    if (!token) {
      result.connection = { state: "unavailable" };
    } else {
      const { RelayOwnerClient } = await import("./extension-relay/owner-client.js");
      const client = await RelayOwnerClient.connect({
        port: result.target.relayPort,
        profile: result.target.profile,
        token,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      });
      try {
        const connection = await client.status();
        result.connection =
          connection.ready && connection.identity
            ? { state: "connected", extensionVersion: connection.identity.extensionVersion }
            : { state: "waiting_for_extension" };
      } finally {
        await client.close();
      }
    }
  } catch {
    signal?.throwIfAborted();
    result.connection = { state: "unavailable" };
  }
  if (result.connection.state === "connected") {
    Object.assign(result, { phase: "ready", reason: "connected", nextAction: "none" });
  } else if (result.phase === "waiting_for_connection") {
    result.reason =
      result.connection.state === "waiting_for_extension"
        ? "extension_disconnected"
        : "relay_unavailable";
  }
  return result;
}
