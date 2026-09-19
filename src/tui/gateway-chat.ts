// Bridges TUI chat requests to gateway session APIs.
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { startGatewayClientWhenEventLoopReady } from "../../packages/gateway-client/src/readiness.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import {
  type HelloOk,
  type AgentsListResult,
  type ArtifactsDownloadResult,
  type ChatHistoryParams,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type CommandEntry,
  type CommandsListParams,
  type CommandsListResult,
  type QuestionGetResult,
  type QuestionListResult,
  type QuestionResolveParams,
  type QuestionResolveResult,
  type SessionsResolveResult,
  type SessionsPatchResult,
  type TaskSuggestionsAcceptResult,
  type TaskSuggestionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { isRetryableGatewayStartupUnavailableError } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  resolveSessionWireTarget,
  resolveLegacySessionRoutingFacts,
  type SessionWireHistory,
} from "../cli/session-target.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayClient, GatewayClientRequestError } from "../gateway/client.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { sleep } from "../utils/sleep.js";
import { VERSION } from "../version.js";
import {
  isLegacyPreserveSideRunsError,
  isLegacySucceedsParentError,
  qualifySessionResult,
  SESSION_REQUEST_KEY_FIELDS,
  type HandoffSessionResolveParams,
  type TuiSessionWireHistory,
} from "./gateway-chat-session-wire.js";
import {
  resolveGatewayConnection,
  resolveBoundGatewayConnection,
  type GatewayConnectionOptions,
  type ResolvedGatewayConnection,
} from "./gateway-connection.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiBackend,
  TuiEvent,
  TuiModelChoice,
  TuiApprovalDecision,
  TuiSessionList,
  TuiSessionDescription,
  TuiSessionCreateOptions,
  TuiSessionMutationResult,
  TuiChatSendResult,
  TuiImageRequest,
  TuiImageData,
} from "./tui-backend.js";
import { isListedTuiSession } from "./tui-session-list-policy.js";

const STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS = 60_000;
const STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS = 500;
const STARTUP_CHAT_HISTORY_MAX_RETRY_MS = 5_000;

function isRetryableStartupUnavailable(
  err: unknown,
  method: string,
): err is GatewayClientRequestError {
  if (!(err instanceof GatewayClientRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

function resolveStartupRetryDelayMs(err: GatewayClientRequestError): number {
  const retryAfterMs =
    typeof err.retryAfterMs === "number" ? err.retryAfterMs : STARTUP_CHAT_HISTORY_DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), STARTUP_CHAT_HISTORY_MAX_RETRY_MS);
}

export class GatewayChatClient implements TuiBackend {
  private client: GatewayClient;
  private legacySessionRouting?: ReturnType<typeof resolveLegacySessionRoutingFacts>;
  private readonly historyLifetime = new AbortController();
  private readyPromise: Promise<void>;
  private resolveReady?: () => void;
  private pendingConnectError?: Error;
  readonly connection: ResolvedGatewayConnection;
  hello?: HelloOk;

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onConnectError?: (error: Error) => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  constructor(connection: ResolvedGatewayConnection) {
    this.connection = connection;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.client = new GatewayClient({
      url: connection.url,
      ...(connection.deviceAuthScope ? { deviceAuthScope: connection.deviceAuthScope } : {}),
      token: connection.token,
      password: connection.password,
      edgeAuthHeaders: connection.edgeAuthHeaders,
      tlsFingerprint: connection.tlsFingerprint,
      preauthHandshakeTimeoutMs: connection.preauthHandshakeTimeoutMs,
      clientName: GATEWAY_CLIENT_NAMES.TUI,
      clientDisplayName: "openclaw-tui",
      clientVersion: VERSION,
      mode: GATEWAY_CLIENT_MODES.UI,
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      caps: [
        GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS,
        GATEWAY_CLIENT_CAPS.AGENT_KIND,
        GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS,
        GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
        GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
      ],
      instanceId: randomUUID(),
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      notifyOnStartupRetry: true,
      onHelloOk: (hello) => {
        this.legacySessionRouting = undefined;
        this.pendingConnectError = undefined;
        this.hello = hello;
        this.resolveReady?.();
        this.onConnected?.();
      },
      onEvent: (evt) => {
        let payload = evt.payload;
        if (
          ["chat", "agent", "session.message"].includes(evt.event) &&
          isRecord(payload) &&
          typeof payload.sessionKey === "string"
        ) {
          const identity = qualifySessionResult({
            key: payload.sessionKey,
            ...(typeof payload.agentId === "string" ? { agentId: payload.agentId } : {}),
          });
          payload = { ...payload, sessionKey: identity.key };
        }
        this.onEvent?.({ event: evt.event, payload, seq: evt.seq });
      },
      onClose: (_code, reason) => {
        this.legacySessionRouting = undefined;
        // Reset so waitForReady() blocks again until the next successful reconnect.
        this.readyPromise = new Promise((resolve) => {
          this.resolveReady = resolve;
        });
        if (this.pendingConnectError && this.onConnectError) {
          // Dedupe is per close-cycle: clearing here lets the next reconnect
          // attempt report its own failure cause. Holding the guard until a
          // successful hello froze the TUI on the first error forever (e.g. a
          // later pairing-required failure and its approval hint never showed).
          this.pendingConnectError = undefined;
          return;
        }
        this.onDisconnected?.(reason);
      },
      onConnectError: (error) => this.notifyConnectError(error),
      onGap: (info) => {
        this.onGap?.(info);
      },
    });
  }

  static async connect(opts: GatewayConnectionOptions): Promise<GatewayChatClient> {
    const connection = await resolveGatewayConnection(opts);
    return new GatewayChatClient(connection);
  }

  /** Connect to a target already selected and authenticated by a preceding Gateway probe. */
  static async connectBound(
    opts: GatewayConnectionOptions & { config: OpenClawConfig; url: string },
  ): Promise<GatewayChatClient> {
    return new GatewayChatClient(await resolveBoundGatewayConnection(opts));
  }

  start() {
    void startGatewayClientWhenEventLoopReady(this.client, {
      clientOptions: { preauthHandshakeTimeoutMs: this.connection.preauthHandshakeTimeoutMs },
    })
      .then((readiness) => {
        if (!readiness.ready && !readiness.aborted) {
          this.notifyUnclosedConnectError(new Error("gateway event loop readiness timeout"));
        }
      })
      .catch((err: unknown) => {
        this.notifyUnclosedConnectError(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private notifyConnectError(error: Error) {
    if (this.pendingConnectError) {
      return;
    }
    if (isRetryableGatewayStartupUnavailableError(error)) {
      return;
    }
    if (
      this.connection.deviceAuthScope &&
      readConnectErrorDetailCode((error as Error & { details?: unknown }).details) ===
        ConnectErrorDetailCodes.PAIRING_REQUIRED &&
      !error.message.includes("Pairing request sent.")
    ) {
      error.message = [
        error.message,
        "Pairing request sent. Approve it in that gateway's Control UI (Settings -> Devices), or run `openclaw devices approve --latest` on the gateway host, then retry.",
      ].join("\n");
    }
    this.pendingConnectError = error;
    this.onConnectError?.(error);
  }

  private notifyUnclosedConnectError(error: Error) {
    const hasStructuredHandler = Boolean(this.onConnectError);
    this.notifyConnectError(error);
    if (!hasStructuredHandler) {
      this.onDisconnected?.(error.message);
    }
  }

  stop() {
    this.historyLifetime.abort();
    // Keep TUI teardown ordered after the transport closes. Otherwise the
    // late close callback can re-arm UI timers after shutdown cleared them.
    return this.client.stopAndWait();
  }

  async subscribeSessionEvents() {
    return await this.client.request("sessions.subscribe", {});
  }

  async waitForReady() {
    await this.readyPromise;
  }

  private async legacyRoutingContract(requiredScope: "global" | "per-sender") {
    const cached = this.legacySessionRouting;
    if (cached && (await cached).scope !== requiredScope && this.legacySessionRouting === cached) {
      this.legacySessionRouting = undefined;
    }
    const pending = (this.legacySessionRouting ??= Promise.all([
      this.client.request<
        ConfigFileSnapshot & { configRevisionHash?: string; appliedConfigHash?: string | null }
      >("config.get", {}),
      this.client.request<AgentsListResult>("agents.list", {}),
    ]).then(([snapshot, agents]) => resolveLegacySessionRoutingFacts(snapshot, agents)));
    void pending.catch(() => {
      if (this.legacySessionRouting === pending) {
        this.legacySessionRouting = undefined;
      }
    });
    const routing = await pending;
    if (routing.scope !== requiredScope) {
      throw new Error(
        `This exact legacy session requires ${requiredScope} session scope. Update the Gateway or select Home.`,
      );
    }
    return routing.contract;
  }

  private async request<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    signal?: AbortSignal,
    dispatch?: (params: Record<string, unknown>, history?: TuiSessionWireHistory) => Promise<T>,
  ): Promise<T> {
    const connection = this.readyPromise;
    const hello = this.hello;
    const readHistory = (request: ChatHistoryParams) =>
      signal
        ? this.client.request<TuiSessionWireHistory>("chat.history", request, { signal })
        : this.client.request<TuiSessionWireHistory>("chat.history", request);
    const wire: Record<string, unknown> = { ...params };
    let selectedHistory: TuiSessionWireHistory | undefined;
    const targetIntent = wire.targetIntent === "home" ? "home" : "exact";
    const parentTargetIntent = wire.parentTargetIntent === "home" ? "home" : "exact";
    delete wire.targetIntent;
    delete wire.parentTargetIntent;
    for (const field of SESSION_REQUEST_KEY_FIELDS[method] ?? []) {
      const key = wire[field];
      if (typeof key !== "string") {
        continue;
      }
      const target = await resolveSessionWireTarget({
        sessionKey: key,
        canonicalSessionKeys:
          hello?.features.capabilities?.includes(GATEWAY_SERVER_CAPS.CANONICAL_SESSION_KEYS) ===
          true,
        targetIntent: field === "parentSessionKey" ? parentTargetIntent : targetIntent,
        sendMessage: method === "chat.send" ? normalizeOptionalString(wire.message) : undefined,
        agentId:
          field !== "parentSessionKey" && typeof wire.agentId === "string"
            ? wire.agentId
            : undefined,
        readHistory,
      });
      if (field !== "parentSessionKey") {
        selectedHistory = target.history;
      }
      if (method === "chat.send" && (target.legacyMain || target.legacyGlobal)) {
        wire.expectedSessionRoutingContract = await this.legacyRoutingContract(
          target.legacyGlobal ? "global" : "per-sender",
        );
        if (target.legacyGlobal) {
          if (!target.sessionId || target.activeLeafEntryId === undefined) {
            throw new Error(
              "Gateway did not provide the physical session guard. Update the Gateway or select Home.",
            );
          }
          wire.sessionId ??= target.sessionId;
          if (wire.expectedLeafEntryId === undefined) {
            wire.expectedLeafEntryId = target.activeLeafEntryId;
          }
        }
      } else if (target.legacyMain) {
        if (method === "sessions.patch" && target.sessionId) {
          wire.expectedSessionId ??= target.sessionId;
        } else if (
          method === "sessions.patch" ||
          method === "sessions.reset" ||
          method === "sessions.create" ||
          (method === "chat.abort" && !wire.runId)
        ) {
          throw new Error("Update this Gateway to modify this exact main session, or select Home.");
        }
      }
      wire[field] = target.sessionKey;
      const requestOwner =
        typeof wire.agentId === "string"
          ? normalizeAgentId(wire.agentId)
          : parseAgentSessionKey(typeof wire.key === "string" ? wire.key : undefined)?.agentId;
      if (
        field === "parentSessionKey" &&
        target.agentId &&
        requestOwner &&
        requestOwner !== target.agentId
      ) {
        if (!parseAgentSessionKey(target.sessionKey)) {
          throw new Error(
            "Update this Gateway before creating a child of another agent's global session.",
          );
        }
      } else if (target.agentId) {
        wire.agentId = target.agentId;
      }
    }
    if (connection !== this.readyPromise || hello !== this.hello) {
      await racePromiseWithAbortSignal(this.readyPromise, signal ?? this.historyLifetime.signal);
      return this.request<T>(method, params, signal, dispatch);
    }
    try {
      const result = await (dispatch
        ? dispatch(wire, selectedHistory)
        : signal
          ? this.client.request<T>(method, wire, { signal })
          : this.client.request<T>(method, wire));
      if (
        ["sessions.resolve", "sessions.patch", "sessions.create", "sessions.reset"].includes(
          method,
        ) &&
        isRecord(result) &&
        typeof result.key === "string"
      ) {
        const qualified = qualifySessionResult(
          {
            key: result.key,
            ...(typeof result.agentId === "string" ? { agentId: result.agentId } : {}),
          },
          typeof wire.agentId === "string" ? wire.agentId : undefined,
        );
        return { ...result, key: qualified.key };
      }
      return result;
    } catch (error) {
      if (
        error instanceof GatewayClientRequestError &&
        isRecord(error.details) &&
        error.details.reason === "session-routing-changed" &&
        connection === this.readyPromise &&
        hello === this.hello
      ) {
        this.legacySessionRouting = undefined;
      }
      throw error;
    }
  }

  async sendChat(opts: ChatSendOptions): Promise<TuiChatSendResult> {
    const runId = opts.runId ?? randomUUID();
    const response = await this.request<{ runId?: unknown; status?: unknown }>("chat.send", {
      sessionKey: opts.sessionKey,
      ...(opts.targetIntent ? { targetIntent: opts.targetIntent } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      idempotencyKey: runId,
    });
    const acceptedRunId = normalizeOptionalString(response?.runId) ?? runId;
    const status = normalizeOptionalString(response?.status);
    return status ? { runId: acceptedRunId, status } : { runId: acceptedRunId };
  }

  async abortChat(opts: Parameters<TuiBackend["abortChat"]>[0]) {
    const params = {
      sessionKey: opts.sessionKey,
      ...(opts.targetIntent ? { targetIntent: opts.targetIntent } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
    };
    if (opts.runId) {
      return await this.request<{ ok: boolean; aborted: boolean; runIds?: string[] }>(
        "chat.abort",
        params,
      );
    }
    try {
      return await this.request<{ ok: boolean; aborted: boolean; runIds?: string[] }>(
        "chat.abort",
        { ...params, preserveSideRuns: true },
      );
    } catch (err) {
      // Protocol v4 peers reject unknown fields. Retry the shipped abort shape
      // so mixed-version TUI stops still work, even without BTW isolation.
      if (!isLegacyPreserveSideRunsError(err)) {
        throw err;
      }
      return await this.request<{ ok: boolean; aborted: boolean; runIds?: string[] }>(
        "chat.abort",
        params,
      );
    }
  }

  async loadHistory(opts: Parameters<TuiBackend["loadHistory"]>[0]) {
    const deadline = Date.now() + STARTUP_CHAT_HISTORY_RETRY_TIMEOUT_MS;
    for (;;) {
      this.historyLifetime.signal.throwIfAborted();
      try {
        const history = await this.request<SessionWireHistory>("chat.history", {
          sessionKey: opts.sessionKey,
          ...(opts.targetIntent ? { targetIntent: opts.targetIntent } : {}),
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          limit: opts.limit,
        });
        if (!history.sessionInfo) {
          return history;
        }
        const sessionInfo = qualifySessionResult(
          history.sessionInfo,
          opts.agentId ?? parseAgentSessionKey(opts.sessionKey)?.agentId,
        );
        return { ...history, sessionKey: sessionInfo.key, sessionInfo };
      } catch (err) {
        if (Date.now() >= deadline || !isRetryableStartupUnavailable(err, "chat.history")) {
          throw err;
        }
        await sleep(resolveStartupRetryDelayMs(err), this.historyLifetime.signal);
      }
    }
  }

  async loadImage(opts: TuiImageRequest): Promise<TuiImageData> {
    const { loadGatewayImage } = await import("./gateway-image-loader.js");
    const signal = AbortSignal.any([opts.signal, this.historyLifetime.signal]);
    const { sessionKey, agentId, targetIntent } = opts;
    const target = { sessionKey, agentId, targetIntent };
    const credentials = [
      this.hello?.auth.deviceToken,
      ...(this.hello?.auth.method === "password"
        ? [this.connection.password, this.connection.token]
        : [this.connection.token, this.connection.password]),
    ].filter((value): value is string => Boolean(value));
    return await loadGatewayImage({
      request: { ...opts, signal },
      connection: this.connection,
      credentials: [...new Set(credentials)],
      withInboundSession: (read, requestSignal) =>
        this.request("assistant.media.get", target, requestSignal, read),
      readMediaBasePath: async (requestSignal) => {
        const snapshot = await this.request<Pick<ConfigFileSnapshot, "runtimeConfig">>(
          "config.get",
          {},
          requestSignal,
        );
        return snapshot.runtimeConfig.gateway?.controlUi?.basePath ?? "";
      },
      downloadArtifact: (artifactId, requestSignal) =>
        this.request<ArtifactsDownloadResult>(
          "artifacts.download",
          { ...target, artifactId },
          requestSignal,
        ),
    });
  }

  async listSessions(opts?: Parameters<TuiBackend["listSessions"]>[0]) {
    const result = await this.request<TuiSessionList>("sessions.list", opts ?? {});
    const sessions = new Map<string, TuiSessionList["sessions"][number]>();
    for (const entry of result.sessions) {
      const row = qualifySessionResult(entry, opts?.agentId);
      const previous = sessions.get(row.key);
      if (previous && (!row.sessionId || row.sessionId !== previous.sessionId)) {
        throw new Error(
          "Gateway has distinct qualified and legacy sessions for this identity. Update and repair the Gateway before selecting it.",
        );
      }
      if (!previous) {
        sessions.set(row.key, row);
      }
    }
    return { ...result, count: sessions.size, sessions: [...sessions.values()] };
  }

  async resolveSession(opts: HandoffSessionResolveParams): Promise<SessionsResolveResult> {
    return await this.request<SessionsResolveResult>("sessions.resolve", opts);
  }

  async describeSession(
    opts: Parameters<TuiBackend["describeSession"]>[0],
  ): Promise<TuiSessionDescription> {
    const { sessionKey, ...target } = opts;
    for (;;) {
      const connection = this.readyPromise;
      const hello = this.hello;
      try {
        const result = await this.request<TuiSessionDescription>(
          "sessions.describe",
          { key: sessionKey, ...target },
          undefined,
          async (wire, history) => {
            const owner =
              typeof wire.agentId === "string"
                ? wire.agentId
                : parseAgentSessionKey(typeof wire.key === "string" ? wire.key : undefined)
                    ?.agentId;
            if (history && !history.sessionInfo?.key) {
              throw new Error("Gateway did not provide the selected session identity.");
            }
            const [description, listing] = await Promise.all([
              history
                ? Promise.resolve({
                    session:
                      typeof history.sessionId === "string" && history.sessionInfo
                        ? { ...history.sessionInfo, sessionId: history.sessionId }
                        : null,
                  })
                : this.client.request<TuiSessionDescription>("sessions.describe", wire),
              this.client.request<TuiSessionList>("sessions.list", { agentId: owner, limit: 1 }),
            ]);
            const session = description.session
              ? qualifySessionResult(description.session, owner)
              : null;
            return {
              session: session && isListedTuiSession(session) ? session : null,
              defaults: listing.defaults,
            };
          },
        );
        if (connection === this.readyPromise && hello === this.hello) {
          return result;
        }
      } catch (error) {
        if (connection === this.readyPromise && hello === this.hello) {
          throw error;
        }
      }
      await racePromiseWithAbortSignal(this.readyPromise, this.historyLifetime.signal);
    }
  }

  async listAgents() {
    return await this.request<TuiAgentsList>("agents.list", {});
  }

  async patchSession(
    opts: Parameters<TuiBackend["patchSession"]>[0],
  ): Promise<SessionsPatchResult> {
    return await this.request<SessionsPatchResult>("sessions.patch", opts);
  }

  async createSession(opts: TuiSessionCreateOptions): Promise<TuiSessionMutationResult> {
    const params = {
      ...opts,
      emitCommandHooks: Boolean(opts.parentSessionKey),
    };
    try {
      return await this.request<TuiSessionMutationResult>("sessions.create", params);
    } catch (err) {
      if (opts.succeedsParent === undefined || !isLegacySucceedsParentError(err)) {
        throw err;
      }
      const { succeedsParent: _succeedsParent, ...legacyParams } = params;
      if (!opts.succeedsParent) {
        // Older Gateways cannot express a linked parallel child. Preserve the
        // parent's lifecycle by retrying as an unlinked child, never a rollover.
        const {
          parentSessionKey: _parentSessionKey,
          emitCommandHooks: _emitCommandHooks,
          ...parallelParams
        } = legacyParams;
        return await this.request<TuiSessionMutationResult>("sessions.create", parallelParams);
      }
      // Legacy rollover is equivalent to an explicit successor request.
      return await this.request<TuiSessionMutationResult>("sessions.create", legacyParams);
    }
  }

  async resetSession(
    key: string,
    reason?: "new" | "reset",
    opts?: Parameters<TuiBackend["resetSession"]>[2],
  ): Promise<TuiSessionMutationResult> {
    return await this.request<TuiSessionMutationResult>("sessions.reset", {
      key,
      ...(opts?.agentId ? { agentId: opts.agentId } : {}),
      ...(opts?.targetIntent ? { targetIntent: opts.targetIntent } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  async getGatewayStatus() {
    return await this.client.request("status");
  }

  async listModels(opts?: { agentId?: string }): Promise<TuiModelChoice[]> {
    const published = this.hello?.features.capabilities?.includes(
      GATEWAY_SERVER_CAPS.PUBLISHED_MODEL_CATALOG,
    );
    const res = await this.client.request("models.list", {
      ...opts,
      ...(published ? { includeDetails: true } : {}),
    });
    const models: TuiModelChoice[] = Array.isArray(res?.models) ? res.models : [];
    // Released Gateways reject includeDetails and collapse unknown availability to false.
    return published
      ? models
      : models.map(({ available: _available, unavailableReason: _reason, ...model }) => model);
  }

  async listCommands(opts?: CommandsListParams): Promise<CommandEntry[]> {
    const res = await this.client.request<CommandsListResult>("commands.list", opts ?? {});
    return Array.isArray(res?.commands) ? res.commands : [];
  }

  async listPluginApprovals() {
    return await this.client.request("plugin.approval.list", {});
  }

  async listQuestions(): Promise<QuestionListResult> {
    return await this.client.request("question.list", {});
  }

  async getQuestion(id: string): Promise<QuestionGetResult> {
    return await this.client.request("question.get", { id });
  }

  async resolveQuestion(params: QuestionResolveParams): Promise<QuestionResolveResult> {
    return await this.client.request("question.resolve", params);
  }

  async resolvePluginApproval(id: string, decision: TuiApprovalDecision) {
    return await this.client.request<{ ok?: boolean }>("plugin.approval.resolve", {
      id,
      decision,
    });
  }

  getTaskSuggestionActionCapabilities() {
    const auth = this.hello?.auth;
    const methods = this.hello?.features?.methods;
    const allows = (method: string, scope: "operator.admin" | "operator.write") =>
      Array.isArray(methods) &&
      methods.includes(method) &&
      Boolean(
        auth &&
        roleScopesAllow({
          role: auth.role,
          requestedScopes: [scope],
          allowedScopes: auth.scopes,
        }),
      );
    return {
      canAccept: allows("taskSuggestions.accept", "operator.admin"),
      canDismiss: allows("taskSuggestions.dismiss", "operator.write"),
    };
  }

  async listTaskSuggestions() {
    if (this.hello?.features?.methods?.includes("taskSuggestions.list") !== true) {
      return [];
    }
    const actions = this.getTaskSuggestionActionCapabilities();
    if (!actions.canAccept && !actions.canDismiss) {
      return [];
    }
    const result = await this.client.request<TaskSuggestionsListResult>("taskSuggestions.list", {});
    return result.suggestions;
  }

  async acceptTaskSuggestion(taskId: string) {
    return await this.client.request<TaskSuggestionsAcceptResult>("taskSuggestions.accept", {
      taskId,
      mode: "local",
    });
  }

  async dismissTaskSuggestion(taskId: string) {
    return await this.client.request<{ taskId: string; dismissed: boolean }>(
      "taskSuggestions.dismiss",
      { taskId },
    );
  }
}
