import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../../state/openclaw-agent-db-registry.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";

/** Keep generation contenders in one physical scope before applying logical ownership. */
export function createSubagentRunStoreScope(
  cfg?: OpenClawConfig,
  admitted?: { sessionKey: string; agentId: string; storePath: string },
) {
  const matchesPath = createOpenClawAgentDatabasePathMatcher();
  const configuredPaths = new Map<string, string>();
  const configuredPath = (sessionKey: string, agentId: string): string => {
    const key = JSON.stringify([agentId, isIncognitoSessionKey(sessionKey)]);
    let storePath = configuredPaths.get(key);
    if (!storePath) {
      storePath = resolveIdentityPathViaExistingAncestorSync(
        resolveSqliteTargetFromSessionStorePath(
          resolveSessionStorePathForScope({ sessionKey, agentId }, cfg),
          { agentId },
        ).path,
      );
      configuredPaths.set(key, storePath);
    }
    return storePath;
  };
  const replacedPath = admitted && configuredPath(admitted.sessionKey, admitted.agentId);
  const admittedPath = admitted && resolveIdentityPathViaExistingAncestorSync(admitted.storePath);
  const resolveStorePath = (sessionKey: string, agentId: string): string => {
    const selected = configuredPath(sessionKey, agentId);
    // Other logical owners of this same physical target retain their generation veto.
    // Distinct child/agent stores keep their own configured placement.
    return replacedPath && admittedPath && matchesPath(selected, replacedPath)
      ? admittedPath
      : selected;
  };
  const matches = (entry: SubagentRunReadRecord, role?: "requester" | "controller"): boolean => {
    const requesterAgentId =
      entry.requesterAgentId ??
      parseAgentSessionKey(entry.requesterSessionKey)?.agentId ??
      (cfg ? resolveSubagentRequesterAgentId(cfg, entry) : undefined);
    const owns = (key: string, storePath: string | undefined, agentId: string | undefined) =>
      Boolean(storePath && agentId && matchesPath(storePath, resolveStorePath(key, agentId)));
    const requester = () =>
      owns(entry.requesterSessionKey, entry.requesterStorePath, requesterAgentId);
    const controller = () => {
      const key = entry.controllerSessionKey?.trim();
      return key
        ? owns(
            key,
            entry.controllerStorePath,
            parseAgentSessionKey(key)?.agentId ?? requesterAgentId,
          )
        : requester();
    };
    return role === "requester"
      ? requester()
      : role === "controller"
        ? controller()
        : requester() || controller();
  };
  return { matches, resolveStorePath };
}

/** Notification ownership follows the physical parent selected when its child was registered. */
export function resolveSubagentRequesterStoreFailure(
  cfg: OpenClawConfig,
  entry: SubagentRunReadRecord,
): string | undefined {
  if (!entry.requesterStorePath) {
    return "Requester session store is unknown for this retained completion; automatic delivery is suspended.";
  }
  return createSubagentRunStoreScope(cfg).matches(entry, "requester")
    ? undefined
    : "Requester session store was replaced; completion remains bound to its original store.";
}

type RunIdentity = Pick<SubagentRunReadRecord, "childSessionKey" | "requesterSessionKey">;
type LookupIdentity = RunIdentity & Pick<SubagentRunReadRecord, "controllerSessionKey">;

function buildChildren(runGroups: readonly Iterable<RunIdentity>[]) {
  const children = new Map<string, Set<string>>();
  for (const runs of runGroups) {
    for (const run of runs) {
      const child = run.childSessionKey.trim();
      if (!child) {
        continue;
      }
      const siblings = children.get(run.requesterSessionKey) ?? new Set<string>();
      siblings.add(child);
      children.set(run.requesterSessionKey, siblings);
    }
  }
  return children;
}

function collectKeys(
  sessionKeys: readonly string[],
  ...childrenForRequester: Array<(requester: string) => Iterable<string>>
): Set<string> {
  const selected = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
  // Include superseded edges; the read index owns the global latest-child veto.
  for (const requester of selected) {
    for (const children of childrenForRequester) {
      for (const child of children(requester)) {
        selected.add(child);
      }
    }
  }
  return selected;
}

/** Select a complete requester closure; the read index still owns generation and liveness policy. */
export function collectSubagentSessionReadKeys(
  sessionKeys: readonly string[],
  ...runGroups: Iterable<RunIdentity>[]
): Set<string> {
  const children = buildChildren(runGroups);
  return collectKeys(sessionKeys, (requester) => children.get(requester) ?? []);
}

type LookupMembership = {
  cacheKey: string;
  requester: string;
  child: string;
  controller: string;
  order: number;
};

/** Derived membership only; the cache's snapshot Map remains the record owner. */
export class SubagentSessionReadLookup {
  #memberships = new Map<string, LookupMembership>();
  #children = new Map<string, Map<string, number>>();
  #byChild = new Map<string, Set<LookupMembership>>();
  #byController = new Map<string, Set<LookupMembership>>();
  #nextOrder = 0;

  constructor(entries: Iterable<readonly [string, LookupIdentity]>) {
    for (const [cacheKey, entry] of entries) {
      this.set(cacheKey, entry);
    }
  }

  set(cacheKey: string, entry: LookupIdentity | undefined): void {
    const previous = this.#memberships.get(cacheKey);
    if (!entry) {
      if (previous) {
        this.#remove(previous);
        this.#memberships.delete(cacheKey);
      }
      return;
    }
    const child = entry.childSessionKey.trim();
    const requester = entry.requesterSessionKey;
    const controller = entry.controllerSessionKey?.trim() || requester;
    if (
      previous &&
      previous.child === child &&
      previous.requester === requester &&
      previous.controller === controller
    ) {
      return;
    }
    if (previous) {
      this.#remove(previous);
    }
    const membership: LookupMembership = {
      cacheKey,
      child,
      requester,
      controller,
      order: previous?.order ?? this.#nextOrder++,
    };
    this.#memberships.set(cacheKey, membership);
    if (membership.child) {
      const children = this.#children.get(membership.requester) ?? new Map<string, number>();
      children.set(membership.child, (children.get(membership.child) ?? 0) + 1);
      this.#children.set(membership.requester, children);
      this.#addToBucket(this.#byChild, membership.child, membership);
    }
    if (membership.controller) {
      this.#addToBucket(this.#byController, membership.controller, membership);
    }
  }

  selectSessions(sessionKeys: readonly string[], inMemoryRuns: Iterable<RunIdentity>) {
    const liveChildren = buildChildren([inMemoryRuns]);
    const selected = collectKeys(
      sessionKeys,
      (requester) => this.#children.get(requester)?.keys() ?? [],
      (requester) => liveChildren.get(requester) ?? [],
    );
    return { sessionKeys: selected, cacheKeys: this.#select(this.#byChild, selected) };
  }

  selectControllers(controllerKeys: ReadonlySet<string>): string[] {
    return this.#select(this.#byController, controllerKeys);
  }

  #select(buckets: Map<string, Set<LookupMembership>>, keys: ReadonlySet<string>): string[] {
    const selected = new Set<LookupMembership>();
    for (const key of keys) {
      for (const membership of buckets.get(key) ?? []) {
        selected.add(membership);
      }
    }
    if (selected.size === this.#memberships.size) {
      return [...this.#memberships.keys()];
    }
    // Bucket traversal can change after a move; snapshot iteration order cannot.
    return [...selected]
      .toSorted((left, right) => left.order - right.order)
      .map((row) => row.cacheKey);
  }

  #addToBucket(
    buckets: Map<string, Set<LookupMembership>>,
    key: string,
    membership: LookupMembership,
  ) {
    const bucket = buckets.get(key) ?? new Set<LookupMembership>();
    bucket.add(membership);
    buckets.set(key, bucket);
  }

  #removeFromBucket(
    buckets: Map<string, Set<LookupMembership>>,
    key: string,
    membership: LookupMembership,
  ) {
    const bucket = buckets.get(key);
    bucket?.delete(membership);
    if (bucket?.size === 0) {
      buckets.delete(key);
    }
  }

  #remove(membership: LookupMembership) {
    const children = this.#children.get(membership.requester);
    const remaining = (children?.get(membership.child) ?? 0) - 1;
    if (remaining > 0) {
      children?.set(membership.child, remaining);
    } else {
      children?.delete(membership.child);
      if (children?.size === 0) {
        this.#children.delete(membership.requester);
      }
    }
    this.#removeFromBucket(this.#byChild, membership.child, membership);
    this.#removeFromBucket(this.#byController, membership.controller, membership);
  }
}
