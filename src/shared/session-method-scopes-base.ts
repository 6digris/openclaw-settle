import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SESSION_READ_SCOPE } from "../gateway/operator-scopes.js";
import { isIncognitoSessionKey } from "./incognito-session-key.js";

export type SessionMutationOperatorScope =
  | "operator.sessions.write"
  | "operator.write"
  | "operator.admin";

const SESSIONS_PATCH_ORGANIZATION_FIELDS: ReadonlySet<string> = new Set([
  "label",
  "pinned",
  "archived",
]);

/** Shared static read floors consumed by Gateway descriptors and browser admission. */
export const SESSION_READ_METHOD_SCOPES = {
  "models.list": SESSION_READ_SCOPE,
  "chat.startup": SESSION_READ_SCOPE,
  "chat.metadata": SESSION_READ_SCOPE,
  "agent.identity.get": SESSION_READ_SCOPE,
  "agents.list": SESSION_READ_SCOPE,
  "chat.history": SESSION_READ_SCOPE,
  "chat.message.get": SESSION_READ_SCOPE,
  "progressCard.get": SESSION_READ_SCOPE,
  "projects.list": SESSION_READ_SCOPE,
  "session.suggestions.list": SESSION_READ_SCOPE,
  "sessions.describe": SESSION_READ_SCOPE,
  "sessions.get": SESSION_READ_SCOPE,
  "sessions.groups.list": SESSION_READ_SCOPE,
  "sessions.list": SESSION_READ_SCOPE,
  "sessions.messages.subscribe": SESSION_READ_SCOPE,
  "sessions.messages.unsubscribe": SESSION_READ_SCOPE,
  "sessions.preview": SESSION_READ_SCOPE,
  "sessions.resolve": SESSION_READ_SCOPE,
  "sessions.search": SESSION_READ_SCOPE,
  "sessions.subscribe": SESSION_READ_SCOPE,
  "sessions.viewers.set": SESSION_READ_SCOPE,
  "themes.get": SESSION_READ_SCOPE,
  "themes.list": SESSION_READ_SCOPE,
  "users.prefs.get": SESSION_READ_SCOPE,
  "users.self": SESSION_READ_SCOPE,
} as const satisfies Record<string, typeof SESSION_READ_SCOPE>;

export function resolveBaseSessionReadRequiredScope(method: string) {
  return Object.hasOwn(SESSION_READ_METHOD_SCOPES, method) ? SESSION_READ_SCOPE : undefined;
}

const SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS: ReadonlySet<string> = new Set([
  "label",
  "autoLabel",
  "icon",
  "color",
  "category",
  "boardFace",
  "boardPresentation",
  "pinned",
  "archived",
  "unread",
  "model",
  "agentRuntime",
  "thinkingLevel",
  "fastMode",
  "permissionMode",
]);

const SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
  "expectedPermissionMode",
  "expectedMarkedUnreadAt",
]);

const SESSIONS_DELETE_WRITE_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "agentId",
  "deleteTranscript",
  "expectedSessionId",
  "archivedOnly",
]);

function resolveSessionsPatchRequiredScope(
  params: unknown,
  envelopeFields?: ReadonlySet<string>,
): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  if (params.permissionMode === "full" || Object.hasOwn(params, "sandboxMode")) {
    return "operator.admin";
  }
  const fields = Object.keys(params);
  const mutations = envelopeFields ? fields.filter((key) => !envelopeFields.has(key)) : fields;
  if (
    mutations.length > 0 &&
    mutations.every((key) => SESSIONS_PATCH_ORGANIZATION_FIELDS.has(key))
  ) {
    return "operator.sessions.write";
  }
  return mutations.every((key) => SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS.has(key))
    ? "operator.write"
    : "operator.admin";
}

function resolveSessionsCreateRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params)) {
    return "operator.write";
  }
  if (
    params.incognito === true ||
    (typeof params.key === "string" && isIncognitoSessionKey(params.key)) ||
    (typeof params.parentSessionKey === "string" &&
      isIncognitoSessionKey(params.parentSessionKey)) ||
    Object.hasOwn(params, "execNode") ||
    Object.hasOwn(params, "toolOverrides") ||
    params.permissionMode === "full"
  ) {
    return "operator.admin";
  }
  return "operator.write";
}

function resolveSessionsDeleteRequiredScope(params: unknown): SessionMutationOperatorScope {
  if (!isRecord(params) || params.archivedOnly !== true) {
    return "operator.admin";
  }
  return Object.keys(params).every((key) => SESSIONS_DELETE_WRITE_SCOPE_FIELDS.has(key))
    ? "operator.write"
    : "operator.admin";
}

/** Browser-safe session mutation policy for methods without protocol validation. */
export function resolveBaseSessionMutationRequiredScope(
  method: string,
  params?: unknown,
): SessionMutationOperatorScope | undefined {
  if (method === "sessions.recover") {
    return "operator.write";
  }
  if (method === "sessions.create") {
    return resolveSessionsCreateRequiredScope(params);
  }
  if (method === "sessions.patch") {
    return resolveSessionsPatchRequiredScope(params, SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS);
  }
  if (method === "sessions.patchMany") {
    return resolveSessionsPatchRequiredScope(isRecord(params) ? params.patch : undefined);
  }
  if (method === "sessions.delete") {
    return resolveSessionsDeleteRequiredScope(params);
  }
  return undefined;
}
