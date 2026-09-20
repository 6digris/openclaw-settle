import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { canCallGatewayMethod } from "../gateway-methods.ts";
import { generateUUID } from "../uuid.ts";
import type { SessionConnectionScope } from "./session-capability.ts";
import type { SessionGroupCatalogHost } from "./session-group-catalog.ts";

const SOURCE_KEY = "openclaw:sessions:custom-groups";
const CLAIM_KEY = SOURCE_KEY + ":import";

type ImportDestination = { gatewayUrl: string; profileId: string | null; agentId: string };
type ImportClaim = ImportDestination & { importId: string };

function readNames(storage: Storage): string[] {
  const value: unknown = JSON.parse(storage.getItem(SOURCE_KEY) ?? "[]");
  return Array.isArray(value)
    ? [
        ...new Set(
          value.flatMap((name) => (typeof name === "string" && name.trim() ? [name.trim()] : [])),
        ),
      ]
    : [];
}

function readClaim(value: unknown): ImportClaim | null {
  return isRecord(value) &&
    typeof value.importId === "string" &&
    Boolean(value.importId) &&
    typeof value.gatewayUrl === "string" &&
    typeof value.agentId === "string" &&
    (value.profileId === null || typeof value.profileId === "string")
    ? {
        importId: value.importId,
        gatewayUrl: value.gatewayUrl,
        profileId: value.profileId,
        agentId: value.agentId,
      }
    : null;
}

/** The claim survives acknowledgement and source changes; only the Gateway consumes names. */
export async function importLegacySessionGroups(
  options: ImportDestination & {
    client: GatewayBrowserClient;
    isCurrent: () => boolean;
  },
): Promise<string | null> {
  try {
    const storage = getSafeLocalStorage();
    const locks = globalThis.navigator?.locks;
    // Without durable storage and cross-tab serialization, leave the source untouched.
    if (!storage || !locks || !options.gatewayUrl || !options.agentId) {
      return null;
    }
    const gatewayUrl = gatewayCredentialScope(options.gatewayUrl);
    const prepared = await locks.request(CLAIM_KEY, async () => {
      if (!options.isCurrent()) {
        return null;
      }
      const names = readNames(storage);
      if (!names.length) {
        return null;
      }
      const raw = storage.getItem(CLAIM_KEY);
      const claim =
        raw === null
          ? {
              importId: generateUUID(),
              gatewayUrl,
              profileId: options.profileId,
              agentId: options.agentId,
            }
          : readClaim(JSON.parse(raw));
      if (
        !claim ||
        claim.gatewayUrl !== gatewayUrl ||
        claim.profileId !== options.profileId ||
        claim.agentId !== options.agentId
      ) {
        return null;
      }
      const serialized = JSON.stringify(claim);
      if (raw === null) {
        storage.setItem(CLAIM_KEY, serialized);
      }
      // A failed/no-op write must never send an unclaimed import.
      if (storage.getItem(CLAIM_KEY) !== serialized) {
        return null;
      }
      return { claim, names, serialized };
    });
    if (!prepared || !options.isCurrent()) {
      return null;
    }
    const { claim, names, serialized } = prepared;
    const result = await options.client.request("sessions.groups.put", {
      agentId: claim.agentId,
      names,
      append: true,
      importId: claim.importId,
    });
    if (!isRecord(result) || result.ok !== true || !options.isCurrent()) {
      return null;
    }
    await locks.request(CLAIM_KEY, async () => {
      if (
        options.isCurrent() &&
        storage.getItem(CLAIM_KEY) === serialized &&
        JSON.stringify(readNames(storage)) === JSON.stringify(names)
      ) {
        storage.removeItem(SOURCE_KEY);
      }
    });
    return options.isCurrent() ? claim.agentId : null;
  } catch {
    // An uncertain outcome retains both source and destination. Catalog reads
    // remain independent; retrying the same receipt cannot resurrect deleted names.
    return null;
  }
}

/** Optional migration policy stays deferred; catalog state remains with its owner. */
export async function importLegacySessionGroupsForCatalog(options: {
  host: SessionGroupCatalogHost;
  scope: SessionConnectionScope;
  owner: (agentId: string) => string;
  profileId: string | null;
  gatewayIdentity: string;
  agentId: string;
  isDisposed: () => boolean;
  onImported: (agentId: string) => void;
}): Promise<void> {
  const { host, scope, owner, profileId, gatewayIdentity, agentId } = options;
  const isCurrent = () =>
    !options.isDisposed() &&
    host.connection.isCurrent(scope) &&
    (host.snapshot().selfUser?.id ?? null) === profileId &&
    host.gatewayIdentity() === gatewayIdentity &&
    owner(host.snapshot().assistantAgentId ?? "") === agentId &&
    canCallGatewayMethod(host.snapshot(), "sessions.groups.put", "operator.write");
  if (!isCurrent()) {
    return;
  }
  const importedAgentId = await importLegacySessionGroups({
    gatewayUrl: host.gatewayUrl(),
    profileId,
    agentId,
    client: scope.client,
    isCurrent,
  });
  if (importedAgentId && isCurrent()) {
    options.onImported(importedAgentId);
  }
}
