import { getSafeLocalStorage } from "../../local-storage.ts";
import { formatUiError } from "../format-error.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import {
  readSessionCustomGroups,
  readSidebarSectionOrder,
  mergeSessionGroupDefaults,
  type SessionGroupSettings,
} from "./custom-groups.ts";
import type {
  SessionConnectionOwner,
  SessionConnectionScope,
  SessionGateway,
  SessionGroupSnapshot,
  SessionGroupMutationResult,
  SessionState,
} from "./session-capability.ts";
import { normalizeAgentId } from "./session-key.ts";

export type SessionGroupCatalogHost = {
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  selectedAgentId: () => string | null;
  gatewayIdentity: () => string;
  gatewayUrl: () => string;
  readState: () => SessionState;
  publish: (state: SessionState, errorSource?: "session-observer" | "operation") => void;
  refreshRows: (agentId: string) => Promise<unknown>;
  retryDelayMs: (error: unknown) => number | null;
};

type SessionGroupAction = "put" | "rename" | "delete" | "update";

type Entry = SessionGroupSnapshot & {
  loaded: boolean;
  mutation: number;
  pending: Promise<readonly SessionGroupSettings[] | null> | null;
  retry: ReturnType<typeof globalThis.setTimeout> | null;
};
const LEGACY_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";
const EMPTY: SessionGroupSnapshot = {
  settings: [],
  sectionOrder: [],
  generation: 0,
  status: "idle",
};

/** One connection owns independent catalogs. Session rows and browser snapshots never seed them. */
export function createSessionGroupCatalog(host: SessionGroupCatalogHost) {
  const entries = new Map<string, Entry>();
  let connection: SessionConnectionScope | null = null;
  let generation = 0;
  let profileId = host.snapshot().selfUser?.id;
  let gatewayIdentity = host.gatewayIdentity();
  let disposed = false;
  let legacyImport: Promise<void> | null = null;
  const owner = (agentId = host.selectedAgentId() ?? host.snapshot().assistantAgentId ?? "") => {
    const value = agentId.trim();
    return value && value !== "*" ? normalizeAgentId(value) : "";
  };
  let selected = owner();
  const clearRetry = (entry: Entry) => {
    if (entry.retry !== null) {
      clearTimeout(entry.retry);
    }
    entry.retry = null;
  };
  const retire = (entry: Entry, status: "idle" | "loading" = "idle") => {
    clearRetry(entry);
    entry.generation = ++generation;
    // Catalog events retire reads, not an in-flight writer's valid acknowledgement.
    if (status === "idle") {
      entry.mutation += 1;
    }
    entry.pending = null;
    entry.loaded = false;
    entry.status = status;
  };
  const reset = () => {
    for (const entry of entries.values()) {
      retire(entry);
    }
    entries.clear();
    legacyImport = null;
    connection = host.connection.capture();
    profileId = host.snapshot().selfUser?.id;
    gatewayIdentity = host.gatewayIdentity();
  };
  const synchronize = () => {
    if (
      (connection ? host.connection.isCurrent(connection) : !host.connection.capture()) &&
      profileId === host.snapshot().selfUser?.id &&
      gatewayIdentity === host.gatewayIdentity()
    ) {
      return;
    }
    reset();
  };
  const entryFor = (agentId: string): Entry => {
    let entry = entries.get(agentId);
    if (!entry) {
      entry = {
        ...EMPTY,
        generation: ++generation,
        loaded: false,
        mutation: 0,
        pending: null,
        retry: null,
      };
      entries.set(agentId, entry);
    }
    return entry;
  };
  const notify = () => {
    const agentId = owner();
    const entry = entries.get(agentId) ?? EMPTY;
    host.publish({
      ...host.readState(),
      groups: entry.settings.map((group) => group.name),
      groupSettings: entry.settings,
      sectionOrder: entry.sectionOrder,
    });
  };
  const snapshot = (agentId?: string): SessionGroupSnapshot => {
    synchronize();
    if (disposed || !connection) {
      return EMPTY;
    }
    const id = owner(agentId);
    return id ? entryFor(id) : EMPTY;
  };
  const select = () => {
    synchronize();
    const next = owner();
    if (selected !== next) {
      // A -> B -> A retires the first A request, not merely its rendered rows.
      const previous = entries.get(selected);
      if (previous) {
        retire(previous);
      }
      selected = next;
    }
    notify();
  };
  const invalidate = (agentId?: string) => {
    synchronize();
    const id = owner(agentId);
    if (id) {
      retire(entryFor(id), "loading");
    }
    notify();
  };
  const ownsEntry = (scope: SessionConnectionScope, id: string, entry: Entry) =>
    !disposed &&
    host.connection.isCurrent(scope) &&
    profileId === host.snapshot().selfUser?.id &&
    gatewayIdentity === host.gatewayIdentity() &&
    entries.get(id) === entry;
  const current = (scope: SessionConnectionScope, id: string, entry: Entry, revision: number) =>
    ownsEntry(scope, id, entry) && entry.generation === revision;

  // Migration is optional background work. An unavailable or uncertain write
  // must never hold the selected agent's canonical read hostage.
  const importLegacy = (scope: SessionConnectionScope) => {
    try {
      if (legacyImport || !getSafeLocalStorage()?.getItem(LEGACY_GROUPS_STORAGE_KEY)) {
        return;
      }
    } catch {
      return;
    }
    const capturedProfileId = host.snapshot().selfUser?.id ?? null;
    const capturedGateway = host.gatewayIdentity();
    const agentId = owner(host.snapshot().assistantAgentId ?? "");
    const settleImport = () => {
      if (legacyImport === task) {
        legacyImport = null;
      }
    };
    const task = import("./session-group-operations.ts")
      .then(({ importLegacySessionGroupsForCatalog }) =>
        importLegacySessionGroupsForCatalog({
          host,
          scope,
          owner,
          profileId: capturedProfileId,
          gatewayIdentity: capturedGateway,
          agentId,
          isDisposed: () => disposed,
          onImported: (importedAgentId) => {
            settleImport();
            if (entries.has(importedAgentId)) {
              invalidate(importedAgentId);
              void load(importedAgentId);
            }
          },
        }),
      )
      .then(settleImport, settleImport);
    legacyImport = task;
  };

  const load = async (agentId?: string): Promise<readonly SessionGroupSettings[] | null> => {
    synchronize();
    const id = owner(agentId);
    const scope = host.connection.capture();
    if (!scope || !id || disposed) {
      return null;
    }
    const entry = entryFor(id);
    if (entry.loaded) {
      return entry.pending ?? (entry.status === "ready" ? entry.settings : null);
    }
    clearRetry(entry);
    entry.loaded = true;
    entry.status = "loading";
    const revision = entry.generation;
    notify();
    const task = (async () => {
      try {
        importLegacy(scope);
        if (!current(scope, id, entry, revision)) {
          return null;
        }
        const listed = await scope.client.request("sessions.groups.list", { agentId: id });
        if (!current(scope, id, entry, revision)) {
          return null;
        }
        entry.settings = readSessionCustomGroups(listed);
        entry.sectionOrder = readSidebarSectionOrder(listed);
        const defaultsAllowed = canCallGatewayMethod(
          host.snapshot(),
          "sessions.groups.defaults",
          "operator.write",
        );
        if (defaultsAllowed) {
          notify();
          const defaults = await scope.client.request("sessions.groups.defaults", { agentId: id });
          if (!current(scope, id, entry, revision)) {
            return null;
          }
          entry.settings = mergeSessionGroupDefaults(entry.settings, defaults);
        }
        entry.status = "ready";
        notify();
        return entry.settings;
      } catch (error) {
        if (!current(scope, id, entry, revision)) {
          return null;
        }
        entry.status = "unavailable";
        notify();
        entry.loaded = false;
        const delay = host.retryDelayMs(error);
        if (delay !== null) {
          entry.retry = setTimeout(() => {
            entry.retry = null;
            if (current(scope, id, entry, revision)) {
              void load(id);
            }
          }, delay);
        }
        return null;
      }
    })()
      .then((result) => {
        // Event invalidation while admitted bootstrap work is pending owns a new read.
        return !disposed &&
          host.connection.isCurrent(scope) &&
          entries.get(id) === entry &&
          entry.generation !== revision &&
          entry.status === "loading"
          ? load(id)
          : result;
      })
      .finally(() => {
        if (entry.pending === task) {
          entry.pending = null;
        }
      });
    entry.pending = task;
    return task;
  };

  const mutate = async (
    agentId: string | undefined,
    action: SessionGroupAction,
    params: Record<string, unknown>,
  ): Promise<SessionGroupMutationResult> => {
    synchronize();
    const id = owner(agentId);
    const scope = host.connection.capture();
    if (!scope || !id || disposed) {
      return "stale";
    }
    const entry = entryFor(id);
    const mutation = ++entry.mutation;
    const isCurrent = () => ownsEntry(scope, id, entry) && entry.mutation === mutation;
    try {
      // Caller-owned UI intent is checked synchronously before this call. Do not
      // insert an await before the transport admits the captured owner's request.
      const result = await scope.client.request("sessions.groups." + action, {
        ...params,
        agentId: id,
      });
      if (!isCurrent()) {
        return "stale";
      }
      invalidate(id);
      if (action === "update") {
        entry.settings = mergeSessionGroupDefaults(entry.settings, result);
        entry.status = "ready";
        entry.loaded = true;
        notify();
      } else {
        entry.settings = readSessionCustomGroups(result);
        entry.sectionOrder = readSidebarSectionOrder(result);
        notify();
        void load(id);
        if (action !== "put") {
          void host.refreshRows(id);
        }
      }
      return "completed";
    } catch (error) {
      if (!isCurrent()) {
        return "stale";
      }
      host.publish({ ...host.readState(), error: formatUiError(error) }, "operation");
      throw error;
    }
  };

  return {
    observed: (agentId: string) => entries.has(owner(agentId)),
    snapshot,
    select,
    reset: () => {
      reset();
      notify();
    },
    dispose: () => {
      disposed = true;
      reset();
    },
    generation: (agentId?: string) => snapshot(agentId).generation,
    status: (agentId?: string) => snapshot(agentId).status,
    invalidate,
    load,
    put: (
      names: readonly string[],
      sectionOrder?: readonly string[],
      agentId?: string,
      append = false,
    ) =>
      mutate(agentId, "put", {
        names: [...names],
        ...(sectionOrder === undefined ? {} : { sectionOrder: [...sectionOrder] }),
        ...(append ? { append: true } : {}),
      }),
    rename: (from: string, to: string, agentId?: string) =>
      mutate(agentId, "rename", { name: from, to }),
    delete: (name: string, agentId?: string) => mutate(agentId, "delete", { name }),
    update: (name: string, defaults: { cwd: string | null; worktree: boolean }, agentId?: string) =>
      mutate(agentId, "update", { name, ...defaults }),
  };
}
