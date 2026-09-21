import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { resolveBaseSessionMutationRequiredScope } from "../shared/session-method-scopes-base.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import {
  authorizeGatewaySessionCreation,
  authorizeCurrentOperatorRoleScopes,
  hasOperatorBoundary,
  hasSessionOnlyWriteAuthority,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { SESSION_WRITE_SCOPE } from "./operator-scopes.js";
import {
  authenticatedProfileUnavailableError,
  gatewayClientSessionCreator,
  isGatewayClientProfilePending,
} from "./server-methods/gateway-client-identity.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  SessionMutationAuthorization,
} from "./server-methods/types.js";
import { isSessionCreatorProfile, prepareSessionCreatorProfile } from "./session-creator.js";
import {
  isAgentRunStartMethod,
  isRequiredSessionTargetMethod,
  isSessionProfileDependentMethod,
} from "./session-method-policy.js";
import {
  expectedSessionMutationTargetError,
  sessionMutationTargetChanged,
  SessionMutationAuthorizationChangedError,
  type ExpectedSessionMutationTarget,
} from "./session-mutation-authorization-error.js";
import {
  resolveRequestedSessionAgentId,
  resolveRequestedSessionAgentInput,
} from "./session-request-agent.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionAgentRun,
  authorizeSessionSharingTarget,
  canManageSessionSharing,
  createSessionListEntryFilter,
  hiddenSessionNotFound,
  isGatewayAdmin,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
  sharingIdentity,
  type SessionSharingRoleParams,
  type SessionSharingTarget,
} from "./session-sharing-policy.js";
import { loadCachedSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";
import {
  resolveDirectIncognitoTargets,
  resolveDirectSessionTargets,
  resolveSessionMutationTargets,
  resolveTalkSessionTargetInput,
  type SessionMutationTarget,
} from "./session-sharing-target-input.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { prepareTalkSessionTarget, assertTalkSessionStorageTarget } from "./talk/session-target.js";
import type { PreparedTalkSessionTarget } from "./talk/session-target.types.js";

type AuthorizedSessionMutationTarget = SessionMutationTarget & {
  resolved: Omit<SessionSharingTarget, "entry" | "storeKeys"> | null;
  sessionId: string | null;
  lifecycleRevision?: string;
};

// Ownership assignment uses visibility (docs/gateway/protocol.md); incognito and role caps still
// prevent view/suggest callers from reassigning foreign sessions they can merely see.
const VISIBILITY_AUTHORIZED_METHODS = new Set(["sessions.assignOwner"]);

export { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
export { invalidateSessionSharingSnapshot } from "./session-sharing-snapshot-cache.js";

export {
  allowedSessionVisibilities,
  authorizeIncognitoSessionTarget,
  authorizeResolvedSessionMutation,
  authorizeSessionSharing,
  authorizeSessionSharingTarget,
  canAccessIncognitoSession,
  canManageSessionSharing,
  createProfileSessionEntryFilter,
  createSessionListEntryFilter,
  isGatewayAdmin,
  isResolvedIncognitoSession,
  isSessionVisibilityAllowed,
  prepareSessionSharingTargets,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionSharingTargets,
  resolveSessionVisibility,
} from "./session-sharing-policy.js";

export function resolveSessionMutationAuthorization(params: {
  client: GatewayClient | null;
  method: string;
  requestParams: unknown;
  context: GatewayRequestContext;
  /** Trusted prepared identity; never adopt a later target while capturing authority. */
  expectedTarget?: ExpectedSessionMutationTarget;
  sessionRowRead?: SessionRowReadView;
}): { authorization?: SessionMutationAuthorization; error: ErrorShape | null } {
  const readPolicy = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  // Routing follows the runtime writer; permission decisions use only committed policy.
  let cachedCfg: OpenClawConfig | undefined;
  const getCfg = (): OpenClawConfig => (cachedCfg ??= params.context.getRuntimeConfig());
  const organizationPatch =
    resolveBaseSessionMutationRequiredScope(params.method, params.requestParams) ===
    SESSION_WRITE_SCOPE;
  const authorizesAgentRun = isAgentRunStartMethod(params.method, params.requestParams);
  const readsProgress = params.method === "progressCard.get";
  // Progress authority includes the current conversation lifecycle, even for admins.
  const bindsProgressLifecycle =
    readsProgress ||
    params.method === "progressCard.put" ||
    params.method === "progressCard.refresh";
  const authorizeTarget = (cfg: OpenClawConfig, target: SessionSharingTarget) =>
    readsProgress
      ? createSessionListEntryFilter({ cfg, client: params.client })?.(
          target.canonicalKey,
          target.entry,
        ) === false
        ? hiddenSessionNotFound(target.canonicalKey)
        : null
      : authorizeSessionSharingTarget({
          cfg,
          client: params.client,
          target,
          requireCreator: organizationPatch && hasSessionOnlyWriteAuthority(params.client, cfg),
        });
  const adminBypass =
    isGatewayAdmin(params.client) &&
    !authorizesAgentRun &&
    !(organizationPatch && hasSessionOnlyWriteAuthority(params.client, readPolicy()));
  if (adminBypass && !bindsProgressLifecycle && !params.expectedTarget) {
    return { error: null };
  }
  if (
    !adminBypass &&
    isGatewayClientProfilePending(params.client) &&
    isSessionProfileDependentMethod(params.method)
  ) {
    return { error: authenticatedProfileUnavailableError() };
  }
  // The role cap precedes handler visibility filtering on the current exact row.
  if (
    params.method === "sessions.describe" ||
    params.method === "sessions.messages.subscribe" ||
    params.method === "sessions.viewers.set"
  ) {
    const projection = params.sessionRowRead ?? getSessionRowProjection(params.context);
    if (projection) {
      const { cfg, policyConfig } = projection.state;
      for (const target of resolveDirectSessionTargets(params.method, params.requestParams)) {
        const agent = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
        if (!agent.ok) {
          return { error: agent.error };
        }
        const row = projection.describe({ key: target.sessionKey, agentId: agent.agentId });
        const sharing = prepareProjectedSessionSharing({
          cfg: policyConfig,
          client: params.client,
          isMember: (_target, identityId) => row?.membership.has(identityId) ?? false,
        });
        if (
          params.method !== "sessions.describe" &&
          sharing.entryFilter &&
          (isIncognitoSessionKey(target.sessionKey) ||
            (row && !sharing.entryFilter(row.key, row.entry)))
        ) {
          return { error: hiddenSessionNotFound(target.sessionKey) };
        }
        if (
          row &&
          gatewayClientSessionCreator(params.client) &&
          sharing.sessionCap === "none" &&
          !sharing.isCreator(row.entry.createdActor)
        ) {
          return { error: hiddenSessionNotFound(target.sessionKey) };
        }
      }
    }
    return { error: null };
  }
  if (params.method === "sessions.list") {
    return { error: null };
  }
  // Commit checks start a fresh lookup cache after asynchronous handler work.
  const createLookupCaches = (): {
    storeCache: GatewaySessionStoreCache;
    targetDiscoveryCache: GatewaySessionStoreDiscoveryCache;
  } => ({ storeCache: new Map(), targetDiscoveryCache: new Map() });
  let lookupCaches: ReturnType<typeof createLookupCaches> | undefined;
  const resolveAuthorizedTarget = (
    targetRef: SessionMutationTarget,
    targetCount: number,
  ): { target: SessionSharingTarget | null } | { error: ErrorShape } => {
    const input = resolveRequestedSessionAgentInput(targetRef.sessionKey, targetRef.agentId);
    if (!input.ok) {
      return { error: input.error };
    }
    try {
      return {
        target: resolveSessionSharingTarget({
          cfg: getCfg(),
          sessionKey: targetRef.sessionKey,
          agentId: input.value,
          ...(lookupCaches ??= createLookupCaches()),
          exactRead: targetCount === 1,
        }),
      };
    } catch (error) {
      if (error instanceof AgentSelectionRequiredError) {
        return {
          error: errorShape(ErrorCodes.INVALID_REQUEST, error.message),
        };
      }
      throw error;
    }
  };
  let talkInput: ReturnType<typeof resolveTalkSessionTargetInput>;
  let talkSessionTarget: PreparedTalkSessionTarget | undefined;
  try {
    talkInput = resolveTalkSessionTargetInput(
      params.method,
      params.requestParams,
      params.client?.connId,
    );
    if (talkInput?.kind === "relay") {
      assertTalkSessionStorageTarget(getCfg(), talkInput.target);
      talkSessionTarget = talkInput.target;
    } else {
      talkSessionTarget = talkInput && prepareTalkSessionTarget(getCfg(), talkInput.sessionKey);
    }
  } catch (error) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        String(error instanceof Error ? error.message : error),
      ),
    };
  }
  const talkTargets = talkSessionTarget
    ? [{ sessionKey: talkSessionTarget.canonicalKey, agentId: talkSessionTarget.agentId }]
    : undefined;
  const directTargets =
    talkTargets ?? resolveDirectSessionTargets(params.method, params.requestParams);
  const hidesForeignSessions =
    !adminBypass &&
    directTargets.length > 0 &&
    gatewayClientSessionCreator(params.client) &&
    operatorSessionCap(params.client, readPolicy()) === "none";
  // Incognito and role-hidden direct reads share the same non-disclosing access boundary.
  const protectedTargets = hidesForeignSessions
    ? directTargets
    : (talkTargets?.filter((target) => isIncognitoSessionKey(target.sessionKey)) ??
      resolveDirectIncognitoTargets(params.method, params.requestParams));
  for (const targetRef of protectedTargets) {
    const resolved = resolveAuthorizedTarget(targetRef, protectedTargets.length);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    const error = authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: targetRef.sessionKey,
      target,
    });
    if (error) {
      return { error };
    }
    if (
      hidesForeignSessions &&
      target &&
      !isSessionCreatorProfile(
        target.entry.createdActor,
        params.client?.authenticatedUserProfile?.profileId,
      )
    ) {
      return { error: hiddenSessionNotFound(targetRef.sessionKey) };
    }
  }
  const targetRefs =
    talkTargets ??
    resolveSessionMutationTargets({
      method: params.method,
      requestParams: params.requestParams,
      context: params.context,
      getCfg,
    });
  if (params.expectedTarget && targetRefs?.length !== 1) {
    return {
      error: sessionMutationTargetChanged(params.method, params.expectedTarget.sessionKey).error,
    };
  }
  if (!targetRefs) {
    if (isRequiredSessionTargetMethod(params.method)) {
      return {
        error: errorShape(ErrorCodes.INVALID_REQUEST, "session mutation target is unavailable", {
          details: { code: "SESSION_MUTATION_TARGET_REQUIRED", method: params.method },
        }),
      };
    }
    return { error: null };
  }
  if (talkSessionTarget && authorizesAgentRun) {
    const error = authorizeGatewaySessionCreation({
      cfg: readPolicy(),
      client: params.client,
      agentId: talkSessionTarget.agentId,
    });
    if (error) {
      return { error };
    }
  }
  const authorizedTargets: AuthorizedSessionMutationTarget[] = [];
  for (const targetRef of targetRefs) {
    const resolved = resolveAuthorizedTarget(targetRef, targetRefs.length);
    if ("error" in resolved) {
      return { error: resolved.error };
    }
    const target = resolved.target;
    const error =
      (!target &&
      ((organizationPatch && hasSessionOnlyWriteAuthority(params.client, readPolicy())) ||
        (readsProgress && hasOperatorBoundary(params.client, readPolicy())))
        ? hiddenSessionNotFound(targetRef.sessionKey)
        : null) ??
      expectedSessionMutationTargetError(params.expectedTarget, target, params.method) ??
      (target && authorizesAgentRun
        ? authorizeSessionAgentRun({
            cfg: readPolicy(),
            client: params.client,
            target,
          })
        : null) ??
      authorizeIncognitoSessionTarget({
        client: params.client,
        sessionKey: targetRef.sessionKey,
        target,
      }) ??
      (target &&
      !(
        VISIBILITY_AUTHORIZED_METHODS.has(params.method) &&
        (operatorSessionCap(params.client, readPolicy()) ?? "write") === "write"
      )
        ? authorizeTarget(readPolicy(), target)
        : null);
    if (error) {
      return { error };
    }
    authorizedTargets.push({
      ...targetRef,
      resolved: target
        ? {
            agentId: target.agentId,
            canonicalKey: target.canonicalKey,
            storeKey: target.storeKey,
            storePath: target.storePath,
          }
        : null,
      sessionId: target?.entry.sessionId?.trim() || null,
      ...(bindsProgressLifecycle ? { lifecycleRevision: target?.entry.lifecycleRevision } : {}),
    });
  }
  return {
    error: null,
    authorization: (() => {
      const targetChanged = (sessionKey: string) =>
        sessionMutationTargetChanged(params.method, sessionKey);
      const assertTalkTargetCurrent = (cfg: OpenClawConfig) => {
        if (!talkInput || !talkSessionTarget) {
          return;
        }
        let current: PreparedTalkSessionTarget;
        try {
          if (talkInput.kind === "relay") {
            if (!talkInput.isCurrent()) {
              throw targetChanged(talkSessionTarget.sessionKey);
            }
            assertTalkSessionStorageTarget(cfg, talkSessionTarget);
            current = talkSessionTarget;
          } else {
            current = prepareTalkSessionTarget(cfg, talkInput.sessionKey);
          }
        } catch {
          throw targetChanged(talkSessionTarget.sessionKey);
        }
        if (
          current.agentId !== talkSessionTarget.agentId ||
          current.sessionKey !== talkSessionTarget.sessionKey ||
          current.canonicalKey !== talkSessionTarget.canonicalKey ||
          current.storePath !== talkSessionTarget.storePath
        ) {
          throw targetChanged(talkSessionTarget.sessionKey);
        }
        const error =
          authorizesAgentRun &&
          authorizeGatewaySessionCreation({
            cfg: readPolicy(),
            client: params.client,
            agentId: current.agentId,
          });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      const assertTargetCurrent = (
        targetRef: SessionMutationTarget,
        expected: AuthorizedSessionMutationTarget | undefined,
        currentCfg: OpenClawConfig,
        currentLookupCaches?: ReturnType<typeof createLookupCaches>,
        ensuredSessionId?: string,
      ) => {
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: targetRef.sessionKey,
          agentId: targetRef.agentId,
          ...currentLookupCaches,
          exactRead: !currentLookupCaches || authorizedTargets.length === 1,
        });
        // The guarded ensure may mint this row/id. Its result permits only that
        // materialization, never a replacement of an already admitted session.
        const ensuredTarget =
          talkSessionTarget &&
          authorizesAgentRun &&
          expected?.sessionId === null &&
          ensuredSessionId
            ? {
                agentId: talkSessionTarget.agentId,
                canonicalKey: talkSessionTarget.canonicalKey,
                storeKey: talkSessionTarget.canonicalKey,
                storePath: talkSessionTarget.storePath,
              }
            : undefined;
        const expectedResolved = expected?.resolved ?? ensuredTarget;
        const expectedSessionId = expected?.sessionId ?? (ensuredTarget ? ensuredSessionId : null);
        const sameResolvedTarget =
          expected !== undefined &&
          (current === null
            ? expected.resolved === null && !ensuredSessionId
            : expectedResolved !== undefined &&
              expectedResolved !== null &&
              current.agentId === expectedResolved.agentId &&
              current.canonicalKey === expectedResolved.canonicalKey &&
              current.storeKey === expectedResolved.storeKey &&
              current.storePath === expectedResolved.storePath &&
              (current.entry.sessionId?.trim() || null) === expectedSessionId &&
              (!bindsProgressLifecycle ||
                current.entry.lifecycleRevision === expected.lifecycleRevision));
        if (!sameResolvedTarget) {
          throw targetChanged(targetRef.sessionKey);
        }
        if (!current) {
          return;
        }
        const error =
          (authorizesAgentRun
            ? authorizeSessionAgentRun({
                cfg: readPolicy(),
                client: params.client,
                target: current,
              })
            : null) ??
          authorizeIncognitoSessionTarget({
            client: params.client,
            sessionKey: targetRef.sessionKey,
            target: current,
          }) ??
          authorizeTarget(readPolicy(), current);
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
      };
      return {
        ...(talkSessionTarget ? { talkSessionTarget } : {}),
        assertCurrent: () => {
          const currentCfg = params.context.getRuntimeConfig();
          assertTalkTargetCurrent(currentCfg);
          const currentLookupCaches = createLookupCaches();
          for (const authorized of authorizedTargets) {
            assertTargetCurrent(authorized, authorized, currentCfg, currentLookupCaches);
          }
        },
        assertTargetCurrent: (targetRef: SessionMutationTarget & { ensuredSessionId?: string }) => {
          // Match the normalized admission target so padded aliases cannot escape its guard.
          const sessionKey = normalizeOptionalString(targetRef.sessionKey);
          const agentId = normalizeOptionalString(targetRef.agentId);
          const normalizedTarget = { sessionKey: sessionKey ?? targetRef.sessionKey, agentId };
          const expected = authorizedTargets.find(
            (target) => target.sessionKey === sessionKey && target.agentId === agentId,
          );
          const currentCfg = params.context.getRuntimeConfig();
          assertTalkTargetCurrent(currentCfg);
          assertTargetCurrent(
            normalizedTarget,
            expected,
            currentCfg,
            undefined,
            targetRef.ensuredSessionId,
          );
        },
      };
    })(),
  };
}

function loadSharingSnapshot(params: Parameters<typeof resolveSessionSharingTarget>[0]) {
  const { sessionKey, agentId } = params;
  return loadCachedSessionSharingSnapshot({
    agentId,
    sessionKey,
    resolve: () => {
      const target = resolveSessionSharingTarget(params);
      return {
        canonicalKey: target?.canonicalKey ?? sessionKey,
        canonicalAgentId: target?.agentId ?? agentId,
        snapshot: {
          // Missing rows occur after deletion. Fail closed here; the delete path also
          // emits an unscoped catalog invalidation so identified readers still refresh.
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          ...(target ? { createdActor: target.entry.createdActor } : {}),
        },
      };
    },
  });
}

export function canReceiveSessionEvent(params: {
  cfg: OpenClawConfig;
  policyConfig?: OpenClawConfig;
  client: GatewayClient;
  sessionKeys: readonly string[];
  agentId?: string;
  event?: string;
  payload?: unknown;
  prepared?: {
    sharing: ReturnType<typeof prepareSessionSharing>;
    target: (sessionKey: string, agentId?: string) => SessionSharingTarget | null;
  };
}): boolean {
  const { cfg, policyConfig = cfg, client, sessionKeys, event } = params;
  if (authorizeCurrentOperatorRoleScopes(client, policyConfig)) {
    return false;
  }
  if (isGatewayAdmin(client)) {
    return true;
  }
  const operatorActor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, operatorActor);
  if (!identity) {
    return (
      (!policyConfig.gateway?.roles || operatorActor?.kind === "system") &&
      event !== "session.suggestion" &&
      event !== "session.typing"
    );
  }
  const sharing = params.prepared?.sharing ?? prepareSessionSharing({ cfg: policyConfig, client });
  const hidesForeignSessions =
    (params.prepared ? sharing.sessionCap : operatorSessionCap(client, policyConfig)) === "none";
  // Discovery remains lazy; these facts belong only to this recipient check, never a socket send.
  const lookup: Omit<Parameters<typeof resolveSessionSharingTarget>[0], "sessionKey"> = {
    cfg,
    agentId: params.agentId,
    exactRead: sessionKeys.length === 1,
    storeCache: new Map(),
    targetDiscoveryCache: new Map(),
  };
  const resolveTarget = (sessionKey: string) =>
    params.prepared
      ? params.prepared.target(sessionKey, params.agentId)
      : resolveSessionSharingTarget({ ...lookup, sessionKey });
  const visible = sessionKeys.every((sessionKey) => {
    const target = params.prepared ? resolveTarget(sessionKey) : undefined;
    const snapshot = params.prepared
      ? {
          visibility: target ? resolveSessionVisibility(target.entry) : "draft",
          incognito: target
            ? target.entry.incognito === true || isIncognitoSessionKey(target.canonicalKey)
            : isIncognitoSessionKey(sessionKey),
          createdActor: target?.entry.createdActor,
        }
      : loadSharingSnapshot({ ...lookup, sessionKey });
    const isCreator = sharing.isCreator(snapshot.createdActor);
    if (snapshot.incognito || (hidesForeignSessions && !isCreator)) {
      return false;
    }
    if (snapshot.visibility !== "draft" || isCreator) {
      return true;
    }
    if (event !== "session.typing") {
      return false;
    }
    const typingTarget = resolveTarget(sessionKey);
    return typingTarget !== null && canManageSessionSharing(sharing.roleForTarget(typingTarget));
  });
  if (!visible || event !== "session.suggestion") {
    return visible;
  }
  const authorId =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { suggestion?: { author?: { id?: unknown } } }).suggestion?.author?.id
      : undefined;
  if (authorId === identity.id) {
    return true;
  }
  return sessionKeys.every((sessionKey) => {
    const target = resolveTarget(sessionKey);
    return target !== null && sharing.roleForTarget(target) !== "viewer";
  });
}

/** Share caller facts across synchronous selection/role projection, never across an await. */
export function prepareSessionSharing(
  params: Pick<SessionSharingRoleParams, "cfg" | "client">,
  prepared?: {
    aliases: ReadonlySet<string>;
    sessionCap: ReturnType<typeof operatorSessionCap>;
    isMember: (target: SessionSharingTarget, identityId: string) => boolean;
  },
) {
  const identity = sharingIdentity(params.client, resolveGatewayOperatorRoleActor(params.client));
  const isCreator = prepareSessionCreatorProfile(identity?.id, prepared?.aliases);
  const preparedPolicy = prepared && { value: prepared.sessionCap };
  const roleForTarget = (target: SessionSharingTarget, isMember?: boolean) =>
    resolveSessionSharingRole(
      {
        ...params,
        target,
        isMember:
          isMember ?? (prepared && Boolean(identity && prepared.isMember(target, identity.id))),
      },
      preparedPolicy,
      isCreator,
    );
  return {
    isCreator,
    sessionCap: prepared?.sessionCap,
    entryFilter: createSessionListEntryFilter(params, isCreator, prepared),
    roleForTarget,
    authorizeTarget: (target: SessionSharingTarget) =>
      authorizeSessionSharingTarget(
        { ...params, target },
        preparedPolicy && { ...preparedPolicy, role: roleForTarget(target) },
      ),
  };
}

export function prepareProjectedSessionSharing(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  isMember: (target: SessionSharingTarget, identityId: string) => boolean;
}) {
  const { cfg, client, isMember } = params;
  if (client?.internal?.syntheticClient) {
    prepareGatewayRecipientProfile(client);
  }
  const actor = resolveGatewayOperatorRoleActor(client);
  const identity = sharingIdentity(client, actor);
  const retained = client?.preparedSessionProfile;
  const profile = identity && retained?.aliases.has(identity.id) ? retained : undefined;
  const roleProfile =
    actor?.kind === "operator" && retained?.aliases.has(actor.profileId) ? retained : undefined;
  const policy =
    actor?.kind === "system"
      ? undefined
      : resolveOperatorRolePolicyForAssignment(
          roleProfile?.profileId,
          roleProfile?.role ?? null,
          cfg,
        );
  return prepareSessionSharing(params, {
    aliases: profile?.aliases ?? new Set(),
    sessionCap: policy?.sessions.others,
    isMember,
  });
}
