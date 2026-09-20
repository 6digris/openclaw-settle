// Session group catalog mutations.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsGroupsDefaultsParams,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureAgentLifecycleBinding,
  matchesAgentLifecycleBinding,
} from "../../agents/agent-lifecycle-registry.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { filterMutableSessionGroupRecords } from "../session-group-defaults-access.js";
import { resolveRequestedSessionGroupAgentId } from "../session-group-scope.js";
import {
  deleteSessionGroup,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  resolveSessionGroupMutationTargetsByName,
  SessionGroupNotEmptyError,
  SessionGroupNotFoundError,
  updateSessionGroupDefaults,
} from "../session-groups.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  isWorkspacePathContainmentCurrent,
  resolveWorkspacePathContainment,
} from "./workspace-path-containment.js";

function captureGroupAgentGuard(
  context: Pick<GatewayRequestContext, "getRuntimeConfig">,
  agentId: string,
  assertAuthority?: () => void,
): () => void {
  const binding = captureAgentLifecycleBinding(context.getRuntimeConfig(), agentId);
  const changed = () =>
    new SessionMutationAuthorizationChangedError(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Session group agent changed; reload the catalog and retry.",
      ),
    );
  if (!binding) {
    throw changed();
  }
  return () => {
    assertAuthority?.();
    if (!matchesAgentLifecycleBinding(context.getRuntimeConfig(), binding)) {
      throw changed();
    }
  };
}

export const sessionGroupHandlers: GatewayRequestHandlers = {
  "sessions.groups.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsListParams, "sessions.groups.list", respond)
    ) {
      return;
    }
    const scope = resolveRequestedSessionGroupAgentId(context.getRuntimeConfig(), params.agentId);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const agentId = scope.agentId;

    respond(
      true,
      { groups: listSessionGroups(agentId), sectionOrder: listSidebarSectionOrder(agentId) },
      undefined,
    );
  },
  "sessions.groups.defaults": async ({ params, respond, client, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsDefaultsParams,
        "sessions.groups.defaults",
        respond,
      )
    ) {
      return;
    }
    const scope = resolveRequestedSessionGroupAgentId(context.getRuntimeConfig(), params.agentId);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const agentId = scope.agentId;

    const defaults = filterMutableSessionGroupRecords({
      cfg: context.getRuntimeConfig(),
      agentId,
      client,
      records: listSessionGroupDefaults(agentId),
    });
    respond(true, { defaults }, undefined);
  },
  "sessions.groups.put": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsPutParams, "sessions.groups.put", respond)
    ) {
      return;
    }
    const scope = resolveRequestedSessionGroupAgentId(context.getRuntimeConfig(), params.agentId);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const agentId = scope.agentId;
    const assertCurrent = captureGroupAgentGuard(
      context,
      agentId,
      sessionMutationAuthorization?.assertCurrent,
    );

    if (params.importId !== undefined && params.append !== true) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "importId requires append:true"),
      );
      return;
    }
    if (params.append && params.sectionOrder !== undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "append cannot replace sectionOrder"),
      );
      return;
    }
    try {
      const groups = putSessionGroups({
        cfg: context.getRuntimeConfig(),
        agentId,
        names: params.names,
        append: params.append,
        importId: params.importId,
        sectionOrder: params.sectionOrder,
        assertCurrent,
        assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
      });
      respond(
        true,
        { ok: true, groups, sectionOrder: listSidebarSectionOrder(agentId) },
        undefined,
      );
      // Catalog-only changes still need to reach other open clients.
      emitSessionsChanged(context, { reason: "groups", agentId }, { catalogOnly: true });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      if (error instanceof SessionGroupNotEmptyError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.groups.rename": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsRenameParams,
        "sessions.groups.rename",
        respond,
      )
    ) {
      return;
    }
    const scope = resolveRequestedSessionGroupAgentId(context.getRuntimeConfig(), params.agentId);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const agentId = scope.agentId;
    const assertCurrent = captureGroupAgentGuard(
      context,
      agentId,
      sessionMutationAuthorization?.assertCurrent,
    );

    try {
      const result = await renameSessionGroup({
        cfg: context.getRuntimeConfig(),
        agentId,
        name: params.name,
        to: params.to,
        assertCurrent,
        assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
      });
      respond(true, { ok: true, ...result }, undefined);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      if (error instanceof SessionGroupNotFoundError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    } finally {
      // Interrupted sweeps can retain catalog entries and committed member moves.
      emitSessionsChanged(context, { reason: "groups", agentId });
    }
  },
  "sessions.groups.update": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsUpdateParams,
        "sessions.groups.update",
        respond,
      )
    ) {
      return;
    }
    const scope = resolveRequestedSessionGroupAgentId(context.getRuntimeConfig(), params.agentId);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const agentId = scope.agentId;
    const assertCurrent = captureGroupAgentGuard(
      context,
      agentId,
      sessionMutationAuthorization?.assertCurrent,
    );

    if (params.cwd && !path.isAbsolute(params.cwd)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session group cwd must be absolute"),
      );
      return;
    }
    const name = normalizeOptionalString(params.name);
    if (!name) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session group name must not be empty"),
      );
      return;
    }
    let cwd = params.cwd;
    const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    if (cwd && !clientScopes.includes(ADMIN_SCOPE)) {
      const containment = await resolveWorkspacePathContainment(cwd, context.getRuntimeConfig());
      if (
        !containment ||
        !isWorkspacePathContainmentCurrent(containment, context.getRuntimeConfig())
      ) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
        );
        return;
      }
      cwd = containment.path;
    }
    assertCurrent();
    if (sessionMutationAuthorization) {
      const currentTargets =
        resolveSessionGroupMutationTargetsByName(context.getRuntimeConfig(), agentId).get(name) ??
        [];
      for (const target of currentTargets) {
        sessionMutationAuthorization.assertTargetCurrent(target);
      }
    }
    const defaults = updateSessionGroupDefaults(
      agentId,
      name,
      {
        cwd,
        worktree: params.worktree,
      },
      process.env,
      assertCurrent,
    );
    if (!defaults) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown session group: ${name}`),
      );
      return;
    }
    respond(
      true,
      {
        ok: true,
        defaults: filterMutableSessionGroupRecords({
          cfg: context.getRuntimeConfig(),
          agentId,
          client,
          records: defaults,
        }),
      },
      undefined,
    );
    emitSessionsChanged(context, { reason: "groups", agentId }, { catalogOnly: true });
  },
  "sessions.groups.delete": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsDeleteParams,
        "sessions.groups.delete",
        respond,
      )
    ) {
      return;
    }
    const scope = resolveRequestedSessionGroupAgentId(context.getRuntimeConfig(), params.agentId);
    if (!scope.ok) {
      respond(false, undefined, scope.error);
      return;
    }
    const agentId = scope.agentId;
    const assertCurrent = captureGroupAgentGuard(
      context,
      agentId,
      sessionMutationAuthorization?.assertCurrent,
    );

    try {
      const result = await deleteSessionGroup({
        cfg: context.getRuntimeConfig(),
        agentId,
        name: params.name,
        assertCurrent,
        assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
      });
      respond(true, { ok: true, ...result }, undefined);
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    } finally {
      emitSessionsChanged(context, { reason: "groups", agentId });
    }
  },
};
