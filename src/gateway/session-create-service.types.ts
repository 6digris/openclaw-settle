import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";

export type TrustedCatalogSessionTarget = {
  model: string;
  agentRuntime: string;
  pluginOwnerId: string;
};

export type CreatedGatewaySession = {
  key: string;
  agentId: string;
  entry: SessionEntry;
  storePath: string;
  isNew: boolean;
};

export type TrustedInitialSessionEntry = {
  agentHarnessId?: NonNullable<SessionEntry["agentHarnessId"]>;
  color?: string;
  pluginOwnerId?: string;
  providerOverride?: string;
  modelOverride?: string;
  modelOverrideRouteResolution?: "resolved";
  cliSessionBindings?: SessionEntry["cliSessionBindings"];
  initializationPending?: true;
  modelSelectionLocked?: true;
  pluginExtensions?: SessionEntry["pluginExtensions"];
};

export type GatewaySessionCommitResult =
  | {
      ok: true;
      key: string;
      agentId: string;
      entry: SessionEntry;
      resolved: { modelProvider: string; model: string };
      resetExisting: boolean;
    }
  | { ok: false; error: ErrorShape };

export type CreateGatewaySessionResult =
  | (Extract<GatewaySessionCommitResult, { ok: true }> & {
      postCommit: { status: "completed" } | { status: "failed"; error: unknown };
    })
  | Extract<GatewaySessionCommitResult, { ok: false }>;
