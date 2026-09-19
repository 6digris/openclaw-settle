import { isTruthyEnvValue } from "../infra/env.js";
import type { createGatewayDispatchStartupTrace } from "./startup-trace.js";

const CLI_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
export async function ensureCliEnvProxyDispatcher(): Promise<void> {
  try {
    const { hasEnvHttpProxyAgentConfigured } = await import("../infra/net/proxy-env.js");
    if (!hasEnvHttpProxyAgentConfigured()) {
      return;
    }
    const { ensureGlobalUndiciEnvProxyDispatcher } =
      await import("../infra/net/undici-global-dispatcher.js");
    ensureGlobalUndiciEnvProxyDispatcher();
  } catch {
    // Best-effort proxy bootstrap; CLI startup should continue without it.
  }
}

function isDebugProxyCaptureEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_ENABLED) ||
    isTruthyEnvValue(env.OPENCLAW_DEBUG_PROXY_REQUIRE)
  );
}

export function shouldBootstrapCliProxyBeforeFastPath(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isDebugProxyCaptureEnvEnabled(env)) {
    return true;
  }
  return CLI_PROXY_ENV_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export async function bootstrapCliProxyCaptureAndDispatcher(
  startupTrace: ReturnType<typeof createGatewayDispatchStartupTrace>,
  options: { ensureDispatcher?: boolean; capture?: boolean } = {},
): Promise<void> {
  // Capture init, exit finalize, and coverage warnings all no-op unless the
  // debug-proxy env requests capture; importing their sqlite-store graph anyway
  // costs ~100 MB RSS on metadata-only commands such as `plugins list --json`.
  if (options.capture !== false && isDebugProxyCaptureEnvEnabled()) {
    const [
      { initializeDebugProxyCapture, finalizeDebugProxyCapture },
      { maybeWarnAboutDebugProxyCoverage },
    ] = await startupTrace.measure("proxy-imports", () =>
      Promise.all([import("../proxy-capture/runtime.js"), import("../proxy-capture/coverage.js")]),
    );
    initializeDebugProxyCapture("cli");
    process.once("exit", () => {
      finalizeDebugProxyCapture();
    });
    maybeWarnAboutDebugProxyCoverage(undefined, (message) => console.warn(message));
  }
  if (options.ensureDispatcher !== false) {
    await startupTrace.measure("proxy-dispatcher", () => ensureCliEnvProxyDispatcher());
  }
}
