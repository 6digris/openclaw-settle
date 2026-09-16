import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  type SessionCatalog,
  type SessionCatalogLocator,
  type SessionCatalogShareRoute,
  type SessionsCatalogArchiveParams,
  type SessionsCatalogContinueParams,
  type SessionsCatalogListParams,
  type SessionsCatalogReadParams,
  validateSessionsCatalogArchiveParams,
  validateSessionsCatalogContinueParams,
  validateSessionsCatalogListParams,
  validateSessionsCatalogReadParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type {
  SessionCatalogCreateTarget,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";
import { authorizeGatewaySessionCreation } from "../operator-role-policy.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { authorizeSessionCatalogThread } from "./session-catalog-authorization.js";
import { continueAuthorizedSessionCatalog } from "./session-catalog-continue.js";
import { catalogError, projectSessionCatalogFinalResult } from "./session-catalog-delivery.js";
import {
  createSessionCatalogRequestEntrySnapshot,
  type SessionCatalogInstances,
} from "./session-catalog-entry-snapshot.js";
import {
  catalogListCache,
  createSessionCatalogListLifetime,
  invalidateSessionCatalogLists,
  sessionCatalogListKey,
  type CatalogFinalResponsePermit,
  type CatalogListCacheEntry,
  type CatalogListEnumeration,
  type CatalogListResult,
  type SessionCatalogListLifetime,
} from "./session-catalog-list-lifetime.js";
import {
  allowProcessHomeFallback,
  createSessionCatalogRequestNodeSnapshot,
  listSessionCatalogProvider,
  catalogRegistrationSnapshot,
} from "./session-catalog-provider-access.js";
import { readAuthorizedSessionCatalog } from "./session-catalog-read.js";
import { catalogStartHandler } from "./session-catalog-terminal-start.js";
import {
  projectSessionCatalogResult,
  resolveSessionCatalogVisibility,
} from "./session-catalog-visibility.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS = 500;
const SESSION_CATALOG_SHARE_WINDOW_MS = 3_000;
const SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES = 128;

function normalizeSessionCatalogSearch(search: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(search);
  return normalized
    ? truncateUtf16Safe(normalized, SESSION_CATALOG_SEARCH_MAX_UTF16_UNITS)
    : undefined;
}

export function resolveSessionCatalogProvider(
  catalogId: string,
): SessionCatalogProvider | undefined {
  return catalogRegistrationSnapshot().providers.find((candidate) => candidate.id === catalogId);
}

type SessionCatalogCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget & { pluginOwnerId: string } }
  | { ok: false; message: string; unknownCatalog?: true };

type ProviderCreateTargetResolution =
  | { ok: true; target: SessionCatalogCreateTarget }
  | { ok: false; message: string };

const providerCreateTargetsByConfig = new WeakMap<
  OpenClawConfig,
  WeakMap<SessionCatalogProvider, Map<string, ProviderCreateTargetResolution>>
>();

function providerCreateTargetCache(
  config: OpenClawConfig,
  provider: SessionCatalogProvider,
): Map<string, ProviderCreateTargetResolution> {
  let byProvider = providerCreateTargetsByConfig.get(config);
  if (!byProvider) {
    byProvider = new WeakMap();
    providerCreateTargetsByConfig.set(config, byProvider);
  }
  let byAgent = byProvider.get(provider);
  if (!byAgent) {
    byAgent = new Map();
    byProvider.set(provider, byAgent);
  }
  return byAgent;
}

function resolveProviderCreateTarget(
  provider: SessionCatalogProvider,
  agentId: string,
  config: OpenClawConfig,
): ProviderCreateTargetResolution {
  const cache = providerCreateTargetCache(config, provider);
  const cached = cache.get(agentId);
  if (cached) {
    // The provider contract makes create targets config-derived. A reload changes config identity;
    // retaining the old target would advertise a model no longer allowed.
    return cached;
  }
  let resolution: ProviderCreateTargetResolution;
  try {
    const target = provider.resolveCreateSession?.({ agentId });
    const model = target?.model.trim();
    const agentRuntime = target?.agentRuntime.trim();
    resolution =
      model && agentRuntime
        ? { ok: true, target: { model, agentRuntime } }
        : { ok: false, message: `session catalog ${provider.id} cannot create sessions` };
  } catch (error) {
    // Resolver exceptions are not config state. Retry them on the next request so a transient
    // provider initialization failure cannot suppress session creation until config reload.
    return { ok: false, message: catalogError(error).message };
  }
  cache.set(agentId, resolution);
  return resolution;
}

/** Resolves a catalog-owned create target at the start of sessions.create. */
export function resolveRegisteredCatalogCreateTarget(
  catalogId: string,
  agentId: string,
  config: OpenClawConfig,
): SessionCatalogCreateTargetResolution {
  const registration = catalogRegistrationSnapshot().registrations.find(
    (entry) => entry.provider.id === catalogId,
  );
  if (!registration) {
    return {
      ok: false,
      message: `unknown session catalog: ${catalogId}`,
      unknownCatalog: true,
    };
  }
  const resolved = resolveProviderCreateTarget(registration.provider, agentId, config);
  return resolved.ok
    ? { ok: true, target: { ...resolved.target, pluginOwnerId: registration.pluginId } }
    : resolved;
}

function providerOrRespond(
  catalogId: string,
  respond: RespondFn,
): SessionCatalogProvider | undefined {
  const provider = resolveSessionCatalogProvider(catalogId);
  if (!provider) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${catalogId}`),
    );
  }
  return provider;
}

async function authorizeCatalogRequest(params: {
  access: "read" | "mutate";
  request: SessionCatalogLocator & { agentId?: string };
  provider: SessionCatalogProvider;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
}): Promise<{ agentId: string; allowProcessHomeFallback: boolean } | null> {
  const resolvedAgent = resolveAgentIdOrRespondError({
    rawAgentId: params.request.agentId,
    respond: params.respond,
    cfg: params.context.getRuntimeConfig(),
    normalize: normalizeOptionalString,
  });
  if (!resolvedAgent) {
    return null;
  }
  const authorization = await authorizeSessionCatalogThread({
    access: params.access,
    agentId: resolvedAgent.agentId,
    client: params.client,
    context: params.context,
    provider: params.provider,
    request: params.request,
    respond: params.respond,
  });
  return authorization ? { agentId: resolvedAgent.agentId, ...authorization } : null;
}

function registrationOrRespond(catalogId: string, respond: RespondFn) {
  const registration = catalogRegistrationSnapshot().registrations.find(
    (candidate) => candidate.provider.id === catalogId,
  );
  if (!registration) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${catalogId}`),
    );
  }
  return registration;
}

function catalogResult(
  provider: SessionCatalogProvider,
  shareRoute: SessionCatalogShareRoute | undefined,
  hosts: SessionCatalog["hosts"],
  error?: SessionCatalog["error"],
  createSession?: NonNullable<SessionCatalog["capabilities"]["createSession"]>,
): SessionCatalog {
  return {
    id: provider.id,
    label: provider.label,
    capabilities: {
      continueSession: Boolean(provider.continueSession || provider.copyToGatewaySession),
      archive: Boolean(provider.archive),
      ...(provider.openTerminal ? { openTerminal: true } : {}),
      ...(createSession ? { createSession } : {}),
      ...(provider.startTerminalSession ? { startTerminal: true } : {}),
    },
    ...(shareRoute ? { shareRoute } : {}),
    hosts,
    ...(error ? { error } : {}),
  };
}

export const sessionCatalogHandlers: GatewayRequestHandlers = {
  "sessions.catalog.list": async ({ params, respond, context, client, signal }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogListParams,
        "sessions.catalog.list",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogListParams;
    if (request.cursors !== undefined && request.catalogId === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "catalogId is required when cursors are provided"),
      );
      return;
    }
    const catalogRegistrations = catalogRegistrationSnapshot();
    let selected: SessionCatalogProvider[];
    if (request.catalogId) {
      const provider = catalogRegistrations.providers.find(
        (candidate) => candidate.id === request.catalogId,
      );
      if (!provider) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown session catalog: ${request.catalogId}`),
        );
        return;
      }
      selected = [provider];
    } else {
      selected = catalogRegistrations.providers;
    }
    const providerAudiences = new Map(selected.map((provider) => [provider.id, provider.audience]));
    const config = context.getRuntimeConfig();
    const resolvedAgent = resolveAgentIdOrRespondError({
      rawAgentId: request.agentId,
      respond,
      cfg: config,
      normalize: normalizeOptionalString,
    });
    if (!resolvedAgent) {
      return;
    }
    const search = normalizeSessionCatalogSearch(request.search);
    const allowHomeFallback = allowProcessHomeFallback(context.logGateway);
    // Cached provider enumeration is not permission. Each synchronous delivery gets current
    // caller facts and one canonical index, never the provider's pre-await planning snapshot.
    const projectResult = (
      result: CatalogListEnumeration,
      listEntries?: SessionCatalogListLifetime["listEntries"],
    ): CatalogListResult =>
      projectSessionCatalogResult(result, {
        client,
        config: context.getRuntimeConfig(),
        fallbackAgentId: resolvedAgent.agentId,
        providerAudiences,
        listEntries,
      });
    const progressId = request.progressId;
    const progressConnId = progressId && client?.connId ? client.connId : undefined;
    const isCallerCurrent = () =>
      signal?.aborted !== true &&
      client?.invalidated !== true &&
      (!client?.internal?.agentRuntimeIdentity ||
        context.validateAgentRuntimeApprovalAuthority?.(client.internal.agentRuntimeIdentity) ===
          true);
    const isProgressCurrent = () =>
      isCallerCurrent() &&
      client?.connectionSignal?.aborted !== true &&
      (!progressConnId || context.isConnectionActive?.(progressConnId) !== false);
    const assertCallerCurrent = () => {
      if (!isCallerCurrent()) {
        throw createAbortError("Session catalog caller is no longer current");
      }
    };
    const subscribe = (progress: SessionCatalogListLifetime) => {
      if (progressConnId && progressId) {
        progress.subscribe(
          `${progressConnId}\0${progressId}`,
          (catalog, instances) => {
            const projected = projectResult(
              { catalogs: [catalog], instances },
              progress.listEntries,
            ).catalogs[0];
            progress.assertPublicationCurrent();
            if (!isProgressCurrent()) {
              return;
            }
            context.broadcastToConnIds(
              "sessions.catalog.host",
              { progressId, agentId: resolvedAgent.agentId, catalog: projected },
              new Set([progressConnId]),
              { dropIfSlow: true },
            );
          },
          isProgressCurrent,
          client?.connectionSignal ?? signal,
        );
      }
    };
    const listKey = sessionCatalogListKey({
      agentId: resolvedAgent.agentId,
      client,
      request,
      search,
      allowProcessHomeFallback: allowHomeFallback,
      visibilityKey: resolveSessionCatalogVisibility(client, config).cacheKey,
    });
    const cacheState = catalogListCache(context, config, catalogRegistrations);
    const cache = cacheState.entries;
    const cached = cache.get(listKey);
    if (
      cached &&
      !cached.progress.invalidated &&
      (cached.expiresAt === undefined || cached.expiresAt > Date.now())
    ) {
      // progressId is connection-owned and excluded from the work key. Active followers register
      // for the remaining host frames; settled followers receive only the authoritative result.
      const pending = cached.expiresAt === undefined;
      const response = pending ? cached.progress.joinFinalResponse(isCallerCurrent) : undefined;
      if (!pending || response) {
        try {
          if (pending) {
            subscribe(cached.progress);
          }
          cache.delete(listKey);
          cache.set(listKey, cached);
          const result = await cached.result;
          let projected: CatalogListResult;
          if (response) {
            projected = projectSessionCatalogFinalResult({
              result,
              progress: cached.progress,
              response,
              project: projectResult,
            });
          } else {
            assertCallerCurrent();
            projected = projectResult(result);
            assertCallerCurrent();
          }
          if (cached.progress.invalidated && cache.get(listKey) === cached) {
            cache.delete(listKey);
          }
          respond(true, projected);
          return;
        } finally {
          response?.release();
        }
      }
      assertCallerCurrent();
    }
    if (cached && cache.get(listKey) === cached) {
      cache.delete(listKey);
    }
    const registry = catalogRegistrations.registry;
    const scopedRuntime = getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
    const epoch = registry ? capturePluginRegistryLifecycleEpoch(registry) : undefined;
    const registryAuthority = registry
      ? capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime })
      : undefined;
    const registrySignal = registry
      ? capturePluginRegistryLifecycleSignal(registry, epoch, { scopedRuntime })
      : undefined;
    const resolveGatewayContext = context.resolveGatewayContext;
    const progress = createSessionCatalogListLifetime(
      cacheState,
      () =>
        (!resolveGatewayContext || resolveGatewayContext() === context) &&
        (!registry ||
          (registryAuthority?.() === true &&
            registry.sessionCatalogs === catalogRegistrations.source)),
      [
        getGatewayRestartDrainSignal(),
        context.requestEntryLifetime?.signal,
        registrySignal,
        signal,
      ].filter((candidate): candidate is AbortSignal => candidate !== undefined),
    );
    let response: CatalogFinalResponsePermit | undefined;
    let entry: CatalogListCacheEntry | undefined;
    try {
      response = progress.joinFinalResponse(isCallerCurrent);
      if (!response) {
        throw createAbortError("Session catalog caller is no longer current");
      }
      subscribe(progress);
      const operation = (async () => {
        const requestEntries = selected.some((provider) => provider.audience !== "session-viewers")
          ? createSessionCatalogRequestEntrySnapshot({
              cfg: config,
              fallbackAgentId: resolvedAgent.agentId,
              listEntries: progress.listEntries,
            })
          : undefined;
        requestEntries?.freeze();
        const instances: SessionCatalogInstances = new Map();
        const listNodes = createSessionCatalogRequestNodeSnapshot();
        const catalogList = await Promise.all(
          selected.map(async (provider): Promise<SessionCatalog> => {
            const shareRoute = catalogRegistrations.shareRoutes.get(provider);
            const createTarget = resolveProviderCreateTarget(
              provider,
              resolvedAgent.agentId,
              config,
            );
            const createSession = createTarget.ok
              ? {
                  model: createTarget.target.model,
                  ...(provider.startTerminalSession ? { startTerminal: true as const } : {}),
                }
              : undefined;
            const onHost = (host: SessionCatalog["hosts"][number]) => {
              requestEntries?.captureHostInstances(host, instances);
              const catalog = catalogResult(provider, shareRoute, [host], undefined, createSession);
              // Progressive frames are an optimization. The final RPC response remains
              // authoritative when a slow client drops an intermediate host update.
              progress.publish(catalog, instances);
            };
            try {
              const hosts = await progress.runProvider(onHost, (lifetime) => {
                const providerParams = {
                  agentId: resolvedAgent.agentId,
                  allowProcessHomeFallback: allowHomeFallback,
                  search,
                  limitPerHost: request.limitPerHost,
                  hostIds: request.hostIds,
                  ...(request.cursors !== undefined ? { cursors: request.cursors } : {}),
                  sessionEntries: requestEntries?.sessionEntries,
                  listNodes,
                  ...lifetime,
                };
                return listSessionCatalogProvider(provider, providerParams, progress.assertCurrent);
              });
              for (const host of hosts) {
                requestEntries?.captureHostInstances(host, instances);
              }
              return catalogResult(provider, shareRoute, hosts, undefined, createSession);
            } catch (error) {
              return catalogResult(provider, shareRoute, [], catalogError(error), createSession);
            }
          }),
        );
        return { catalogs: catalogList, instances };
      })();
      entry = { progress, result: operation };
      // Raw enumeration stays shareable for 3s within the caller's authority partition. Privacy
      // and creator projection are refreshed per delivery, independently of metadata expiry.
      cache.set(listKey, entry);
      pruneMapToMaxSize(cache, SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES);
      const result = await operation;
      const projected = projectSessionCatalogFinalResult({
        result,
        progress,
        response,
        project: projectResult,
      });
      if (cache.get(listKey) === entry) {
        if (progress.invalidated) {
          cache.delete(listKey);
        } else {
          entry.expiresAt = Date.now() + SESSION_CATALOG_SHARE_WINDOW_MS;
        }
      }
      respond(true, projected);
    } catch (error) {
      progress.retire(error);
      if (entry && cache.get(listKey) === entry) {
        cache.delete(listKey);
      }
      throw error;
    } finally {
      try {
        response?.release();
      } finally {
        progress.finishListing();
      }
    }
  },

  "sessions.catalog.read": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogReadParams,
        "sessions.catalog.read",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogReadParams;
    const provider = providerOrRespond(request.catalogId, respond);
    if (!provider) {
      return;
    }
    try {
      const authorization = await authorizeCatalogRequest({
        access: "read",
        request,
        provider,
        respond,
        context,
        client,
      });
      if (!authorization) {
        return;
      }
      const result = await readAuthorizedSessionCatalog({
        request,
        provider,
        ...authorization,
        client,
        context,
      });
      if (!result.ok) {
        respond(false, undefined, result.error);
        return;
      }
      respond(true, result.page);
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },

  "sessions.catalog.continue": async ({
    params,
    respond,
    client,
    context,
    sessionMutationCommitGuard,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogContinueParams,
        "sessions.catalog.continue",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogContinueParams;
    const registration = registrationOrRespond(request.catalogId, respond);
    if (!registration) {
      return;
    }
    const provider = registration.provider;
    if (!provider.continueSession && !provider.copyToGatewaySession) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog is view-only"));
      return;
    }
    try {
      const authorization = await authorizeCatalogRequest({
        access: "mutate",
        request,
        provider,
        respond,
        context,
        client,
      });
      if (!authorization) {
        return;
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg: context.getRuntimeConfig(),
        client,
        agentId: authorization.agentId,
      });
      if (creationError) {
        respond(false, undefined, creationError);
        return;
      }
      const continued = await continueAuthorizedSessionCatalog({
        request,
        registration,
        agentId: authorization.agentId,
        allowProcessHomeFallback: authorization.allowProcessHomeFallback,
        client,
        context,
        commitGuard: sessionMutationCommitGuard,
      });
      if (!continued.ok) {
        respond(false, undefined, continued.error);
        return;
      }
      respond(true, { sessionKey: continued.sessionKey });
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },

  "sessions.catalog.startTerminal": catalogStartHandler(resolveSessionCatalogProvider),

  "sessions.catalog.archive": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsCatalogArchiveParams,
        "sessions.catalog.archive",
        respond,
      )
    ) {
      return;
    }
    const request = params as SessionsCatalogArchiveParams;
    const provider = providerOrRespond(request.catalogId, respond);
    if (!provider) {
      return;
    }
    if (!provider.archive) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "catalog cannot archive"));
      return;
    }
    try {
      const authorization = await authorizeCatalogRequest({
        access: "mutate",
        request,
        provider,
        respond,
        context,
        client,
      });
      if (!authorization) {
        return;
      }
      const { catalogId: _catalogId, ...providerRequest } = request;
      const result = await provider.archive({
        ...providerRequest,
        agentId: authorization.agentId,
        allowProcessHomeFallback: authorization.allowProcessHomeFallback,
      });
      invalidateSessionCatalogLists(context);
      respond(true, result);
    } catch (error) {
      const details = catalogError(error);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, details.message, { details }),
      );
    }
  },
};
