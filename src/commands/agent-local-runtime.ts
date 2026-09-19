// Loaded only by explicit --local execution; Gateway dispatch does not own embedded state.
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import { getRuntimeConfig } from "../config/io.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPublishedSystemEventStoreSelection,
  publishSystemEventStoreSelection,
} from "../infra/system-event-ownership.js";
import {
  startOneShotDiagnosticsExporters,
  type OneShotDiagnosticsHandle,
} from "../plugins/one-shot-diagnostics.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand } from "./agent.js";

type EmbeddedRunDiagnosticsOptions = {
  suppressStdoutDiagnosticLogs: boolean;
};

async function startEmbeddedRunDiagnosticsExporters(
  runtime: RuntimeEnv,
  options: EmbeddedRunDiagnosticsOptions,
  config: OpenClawConfig,
): Promise<OneShotDiagnosticsHandle | null> {
  try {
    return await startOneShotDiagnosticsExporters({
      config,
      suppressStdoutDiagnosticLogs: options.suppressStdoutDiagnosticLogs,
    });
  } catch (err) {
    // Exporter startup must never break the agent run itself.
    runtime.error?.(`diagnostics exporter startup failed for embedded run: ${String(err)}`);
    return null;
  }
}

/** Own embedded notification admission and flush one-shot diagnostics before the CLI exits. */
export async function runEmbeddedAgentCommand(
  opts: Parameters<typeof agentCommand>[0],
  runtime: RuntimeEnv,
  deps: Parameters<typeof agentCommand>[2],
  diagnosticsOptions: EmbeddedRunDiagnosticsOptions,
) {
  const previousSelection = getPublishedSystemEventStoreSelection();
  const config = getRuntimeConfig();
  publishSystemEventStoreConfig(config);
  const ownedSelection = getPublishedSystemEventStoreSelection();
  let diagnostics: OneShotDiagnosticsHandle | null = null;
  let stopLocalAuditWriter: (() => Promise<void>) | undefined;
  try {
    diagnostics = await startEmbeddedRunDiagnosticsExporters(runtime, diagnosticsOptions, config);
    if (isExecutionIdentityCollectionEnabled(config)) {
      try {
        stopLocalAuditWriter = (
          await import("./agent-local-audit.js")
        ).startAgentLocalAuditWriter();
      } catch {
        // Admission emits one bounded warning if evidence cannot be queued.
      }
    }
    return await agentCommand(opts, runtime, deps);
  } finally {
    try {
      await Promise.all([diagnostics?.stop(), stopLocalAuditWriter?.().catch(() => undefined)]);
    } finally {
      if (getPublishedSystemEventStoreSelection() === ownedSelection) {
        publishSystemEventStoreSelection(previousSelection);
      }
    }
  }
}
