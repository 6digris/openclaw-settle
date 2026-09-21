const OPERATOR_ROLE = "operator";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_TALK_SCOPE = "operator.talk";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_SESSION_READ_SCOPE = "operator.sessions.read";
const OPERATOR_SESSION_WRITE_SCOPE = "operator.sessions.write";
const OPERATOR_SCOPE_PREFIX = "operator.";

export function operatorScopeSatisfied(
  requestedScope: string,
  granted: readonly string[],
): boolean {
  if (!requestedScope.startsWith(OPERATOR_SCOPE_PREFIX)) {
    return false;
  }
  return (
    granted.includes(requestedScope) ||
    granted.includes(OPERATOR_ADMIN_SCOPE) ||
    ((requestedScope === OPERATOR_READ_SCOPE || requestedScope === OPERATOR_TALK_SCOPE) &&
      granted.includes(OPERATOR_WRITE_SCOPE)) ||
    (requestedScope === OPERATOR_SESSION_READ_SCOPE &&
      (granted.includes(OPERATOR_SESSION_WRITE_SCOPE) ||
        granted.includes(OPERATOR_READ_SCOPE) ||
        granted.includes(OPERATOR_WRITE_SCOPE))) ||
    (requestedScope === OPERATOR_SESSION_WRITE_SCOPE && granted.includes(OPERATOR_WRITE_SCOPE))
  );
}

/** Retains grants within a role ceiling, including explicitly selected narrower session access. */
export function applyOperatorRoleScopeCeiling(
  scopes: readonly string[],
  allowedScopes: readonly string[],
): string[] {
  const result = scopes.filter((scope) => operatorScopeSatisfied(scope, allowedScopes));
  if (
    allowedScopes.includes(OPERATOR_SESSION_READ_SCOPE) ||
    allowedScopes.includes(OPERATOR_SESSION_WRITE_SCOPE)
  ) {
    for (const scope of [OPERATOR_SESSION_WRITE_SCOPE, OPERATOR_SESSION_READ_SCOPE]) {
      if (
        operatorScopeSatisfied(scope, allowedScopes) &&
        operatorScopeSatisfied(scope, scopes) &&
        !operatorScopeSatisfied(scope, result)
      ) {
        result.push(scope);
      }
    }
  }
  return result;
}

/** Returns true when a role grant satisfies requested scopes, including operator implications. */
export function roleScopesAllow(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): boolean {
  return resolveMissingRequestedScope(params) === null;
}

/** Returns the original first requested scope not covered by the role's allowed scopes. */
export function resolveMissingRequestedScope(params: {
  role: string;
  requestedScopes: readonly string[];
  allowedScopes: readonly string[];
}): string | null {
  const role = params.role.trim();
  const prefix = `${role}.`;
  const allowedScopes = params.allowedScopes.map((scope) => scope.trim());
  for (const scope of params.requestedScopes) {
    const requestedScope = scope.trim();
    if (!requestedScope) {
      continue;
    }
    const satisfied =
      role === OPERATOR_ROLE
        ? operatorScopeSatisfied(requestedScope, allowedScopes)
        : requestedScope.startsWith(prefix) && allowedScopes.includes(requestedScope);
    if (!satisfied) {
      return scope;
    }
  }
  return null;
}

/** Returns the first requested scope that does not belong to any requested role. */
export function resolveScopeOutsideRequestedRoles(params: {
  requestedRoles: readonly string[];
  requestedScopes: readonly string[];
}): string | null {
  const prefixes = params.requestedRoles.map((role) => `${role.trim()}.`);
  for (const scope of params.requestedScopes) {
    const requestedScope = scope.trim();
    if (!prefixes.some((prefix) => !requestedScope || requestedScope.startsWith(prefix))) {
      return scope;
    }
  }
  return null;
}
