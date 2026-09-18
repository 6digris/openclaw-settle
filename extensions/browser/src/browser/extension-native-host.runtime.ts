import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { buildBrowserExtensionPairing } from "./extension-pairing.js";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";

export function buildBrowserNativeHostPairing(profile?: string) {
  return buildBrowserExtensionPairing({
    cfg: getRuntimeConfig(),
    localTransport: "gateway",
    profile,
  });
}

export function ensureBrowserNativeRelay(port: number, entryPath: string) {
  return ensureExtensionRelayDaemonProcess({ port, cfg: getRuntimeConfig(), entryPath });
}
