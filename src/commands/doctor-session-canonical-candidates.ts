import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listCanonicalSessionRepairFacts,
  type CanonicalSessionRepairFact,
} from "../config/sessions/session-accessor.js";
import type { CanonicalSessionIdentityFact } from "../config/sessions/session-accessor.sqlite-canonical-inventory.js";
import { canonicalSessionKeyMigrationRequiredError } from "../config/sessions/session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { isSameFixedSessionStoreConfig } from "../config/sessions/session-store-config.js";
import { resolvePersistedSessionStoreOwnerForTarget } from "../config/sessions/session-store-owner.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "../config/sessions/store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../gateway/session-store-key.js";
import { isUnscopedSessionKeySentinel, parseAgentSessionKey } from "../routing/session-key.js";
import { applyCanonicalOwnerEvidence } from "./doctor-session-canonical-owner-evidence.js";
import {
  projectExistingAgentDatabaseTargets,
  resolveTargetSqlitePath,
  type ExistingAgentDatabaseTarget,
} from "./doctor-session-sqlite-readers.js";

export type CanonicalSessionCandidate = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  expectedEntry: SessionEntry;
  ownerEvidenceOnly: boolean;
  rawEntryJson?: string;
  sessionKey: string;
  sqlitePath: string;
  storePath: string;
};

export type CanonicalSessionCandidateFact<
  Fact extends CanonicalSessionIdentityFact = CanonicalSessionRepairFact,
> = Omit<CanonicalSessionCandidate, "entry" | "expectedEntry" | "rawEntryJson"> & {
  inventoryFact: Fact;
  lineageRepairRequired: boolean;
  normalizedForkSourceSessionKey?: string;
  normalizedHeartbeatIsolatedBaseSessionKey?: string;
  normalizedParentSessionKey?: string;
  normalizedSpawnedBy?: string;
};

type CanonicalSessionRepairGroup = {
  candidates: CanonicalSessionCandidateFact[];
  removedRows: number;
};

export function listCanonicalSessionStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ExistingAgentDatabaseTarget[] {
  return projectExistingAgentDatabaseTargets(
    resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env }),
    params.env,
  );
}

function createCanonicalSessionKeyResolver(
  params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    registeredDatabases?: readonly { agentId: string; path: string }[];
    readDatabaseOwner?: (pathname: string) => string | undefined;
  },
  stores: readonly ExistingAgentDatabaseTarget[],
) {
  const sharedStores = new Set(
    stores
      .filter(
        (target) =>
          resolveSqliteTargetFromSessionStorePath(target.storePath, {
            agentId: target.agentId,
            env: params.env,
            registeredDatabases: params.registeredDatabases,
            readDatabaseOwner: params.readDatabaseOwner,
          }).shared,
      )
      .map((target) => target.sqlitePath),
  );
  return (sessionKey: string, target: ExistingAgentDatabaseTarget): string => {
    const owner = sharedStores.has(target.sqlitePath)
      ? resolvePersistedSessionStoreOwnerForTarget({
          config: params.cfg,
          sessionKey,
          storePath: target.storePath,
          env: params.env,
        })
      : ({ kind: "none" } as const);
    if (
      sharedStores.has(target.sqlitePath) &&
      owner.kind === "none" &&
      !parseAgentSessionKey(sessionKey) &&
      listAgentIds(params.cfg).length > 1 &&
      isSameFixedSessionStoreConfig(params.cfg.session?.store, target.storePath, params.env)
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        "shared session store aliases require an explicit agents.defaults.sessionStore.agentId owner",
      );
    }
    if (owner.kind === "retired") {
      throw canonicalSessionKeyMigrationRequiredError(
        `session store owner is retired: ${owner.agentId}`,
      );
    }
    return resolveSessionStoreKey({
      cfg: params.cfg,
      storeAgentId: owner.kind === "configured" ? owner.agentId : target.agentId,
      sessionKey,
    });
  };
}

export function normalizeCanonicalSessionCandidateFacts<Fact extends CanonicalSessionIdentityFact>(
  params: Parameters<typeof createCanonicalSessionKeyResolver>[0],
  stores: readonly { target: ExistingAgentDatabaseTarget; facts: readonly Fact[] }[],
): CanonicalSessionCandidateFact<Fact>[] {
  const canonicalizeStoredKey = createCanonicalSessionKeyResolver(
    params,
    stores.map(({ target }) => target),
  );
  const inventory = stores.flatMap(({ target, facts }) =>
    facts.map((inventoryFact) => {
      const { canonicalOwnerSessionKey, sessionKey } = inventoryFact;
      const storedKey = canonicalizeStoredKey(sessionKey, target);
      return {
        canonicalKey: storedKey
          ? resolveDeliveryProvenCanonicalSessionKey(storedKey, inventoryFact)
          : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: target.agentId }),
        canonicalOwnerSessionKey,
        inventoryFact,
        sessionKey,
        storedKey,
        target,
      };
    }),
  );
  const canonicalKeysByStoredKey = applyCanonicalOwnerEvidence(inventory);
  return inventory.map(
    ({ canonicalKey, canonicalOwnerSessionKey, inventoryFact, sessionKey, target }) => {
      const canonicalizeLineageKey = (value: string | undefined) => {
        if (!value) {
          return undefined;
        }
        const storedKey = canonicalizeStoredKey(value, target);
        const ownerAgentId = parseAgentSessionKey(storedKey)?.agentId ?? target.agentId;
        for (const key of [value, storedKey]) {
          const sameStore = canonicalKeysByStoredKey.get(
            `${target.sqlitePath}\0${ownerAgentId}\0${key}`,
          );
          if (sameStore?.size === 1) {
            return [...sameStore][0];
          }
        }
        for (const key of [value, storedKey]) {
          const crossStore = canonicalKeysByStoredKey.get(`*\0${ownerAgentId}\0${key}`);
          if (crossStore?.size === 1) {
            return [...crossStore][0];
          }
        }
        return storedKey;
      };
      const parentSessionKey = canonicalizeLineageKey(inventoryFact.parentSessionKey);
      const spawnedBy = canonicalizeLineageKey(inventoryFact.spawnedBy);
      const forkSourceSessionKey = canonicalizeLineageKey(inventoryFact.forkSourceSessionKey);
      const heartbeatIsolatedBaseSessionKey = canonicalizeLineageKey(
        inventoryFact.heartbeatIsolatedBaseSessionKey,
      );
      return Object.assign(
        {
          agentId: target.agentId,
          canonicalKey,
          inventoryFact,
          lineageRepairRequired:
            parentSessionKey !== inventoryFact.parentSessionKey ||
            spawnedBy !== inventoryFact.spawnedBy ||
            forkSourceSessionKey !== inventoryFact.forkSourceSessionKey ||
            heartbeatIsolatedBaseSessionKey !== inventoryFact.heartbeatIsolatedBaseSessionKey,
          ownerEvidenceOnly: canonicalOwnerSessionKey !== undefined,
          sessionKey,
          sqlitePath: target.sqlitePath,
          storePath: target.storePath,
        },
        forkSourceSessionKey ? { normalizedForkSourceSessionKey: forkSourceSessionKey } : {},
        heartbeatIsolatedBaseSessionKey
          ? { normalizedHeartbeatIsolatedBaseSessionKey: heartbeatIsolatedBaseSessionKey }
          : {},
        parentSessionKey ? { normalizedParentSessionKey: parentSessionKey } : {},
        spawnedBy ? { normalizedSpawnedBy: spawnedBy } : {},
      );
    },
  );
}

export function resolveCanonicalSessionDestination(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  const agentId = resolveSessionStoreAgentId(params.cfg, params.canonicalKey);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId,
    env: params.env,
  });
  return {
    agentId,
    storePath,
    sqlitePath: resolveTargetSqlitePath({ agentId, storePath }),
  };
}

export function assertNoCanonicalSessionIdentityCollisions(
  candidates: readonly {
    canonicalKey: string;
    sessionKey: string;
    sessionId: string;
    sqlitePath: string;
  }[],
): void {
  for (const alias of candidates.filter((candidate) =>
    isUnscopedSessionKeySentinel(candidate.sessionKey),
  )) {
    const collision = candidates.find(
      (candidate) =>
        candidate.canonicalKey === alias.canonicalKey &&
        candidate.sessionKey === alias.canonicalKey &&
        (candidate.sqlitePath !== alias.sqlitePath || candidate.sessionId !== alias.sessionId),
    );
    if (collision) {
      throw canonicalSessionKeyMigrationRequiredError(
        `session identity conflict between "${alias.sessionKey}" (${alias.sessionId}) and "${collision.sessionKey}" (${collision.sessionId}); both conversations are preserved and require explicit collision resolution before repair`,
      );
    }
  }
}

function groupRepairCandidates(
  candidates: readonly CanonicalSessionCandidateFact[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): CanonicalSessionRepairGroup[] {
  const byCanonicalKey = new Map<string, CanonicalSessionCandidateFact[]>();
  for (const candidate of candidates) {
    const group = byCanonicalKey.get(candidate.canonicalKey) ?? [];
    group.push(candidate);
    byCanonicalKey.set(candidate.canonicalKey, group);
  }
  return [...byCanonicalKey.values()].flatMap((group) => {
    assertNoCanonicalSessionIdentityCollisions(
      group.map((candidate) => ({ ...candidate, sessionId: candidate.inventoryFact.sessionId })),
    );
    const first = group[0]!;
    const destination = resolveCanonicalSessionDestination({
      canonicalKey: first.canonicalKey,
      cfg: params.cfg,
      env: params.env,
    });
    const repairRequired =
      group.length > 1 ||
      group.some(
        (candidate) =>
          candidate.inventoryFact.rawCompareRequired ||
          candidate.lineageRepairRequired ||
          candidate.sessionKey !== candidate.canonicalKey ||
          candidate.sqlitePath !== destination.sqlitePath,
      );
    if (!repairRequired) {
      return [];
    }
    const canonicalRowSurvives = group.some(
      (candidate) =>
        candidate.sqlitePath === destination.sqlitePath &&
        candidate.sessionKey === candidate.canonicalKey,
    );
    return [{ candidates: group, removedRows: group.length - (canonicalRowSurvives ? 1 : 0) }];
  });
}

export function collectCanonicalSessionRepairGroups(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  stores: readonly ExistingAgentDatabaseTarget[],
): CanonicalSessionRepairGroup[] {
  return groupRepairCandidates(
    normalizeCanonicalSessionCandidateFacts(
      params,
      stores.map((target) => ({ target, facts: listCanonicalSessionRepairFacts(target) })),
    ),
    params,
  );
}
