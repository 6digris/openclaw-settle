import type { GatewayService } from "../../daemon/service.js";

export async function resolveGatewayRestartSupervision(params: {
  service?: Partial<Pick<GatewayService, "isLoaded">>;
  env?: NodeJS.ProcessEnv;
  supervisorKeepsAlive?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<boolean | undefined> {
  params.signal?.throwIfAborted();
  if (
    params.supervisorKeepsAlive !== undefined ||
    process.platform !== "darwin" ||
    !params.service?.isLoaded
  ) {
    return params.supervisorKeepsAlive;
  }
  // Loaded canonical LaunchAgents retain KeepAlive across a stopped throttle window.
  // Zero would leave the native probe unbounded, so skip exhausted budgets.
  const timeoutMs = Math.floor(Math.min(5000, params.timeoutMs));
  if (timeoutMs <= 0) {
    return undefined;
  }
  const loaded = await params.service.isLoaded({ env: params.env, timeoutMs }).catch(() => false);
  params.signal?.throwIfAborted();
  return loaded;
}
