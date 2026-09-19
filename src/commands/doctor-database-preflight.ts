import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import type { OpenClawDatabaseSchemaPreflight } from "../state/openclaw-database-preflight.js";

export type DoctorDatabasePreflight = OpenClawDatabaseSchemaPreflight & {
  agentDatabaseMigrationDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
};

/** Prepare fleet facts through the artifact-preserving schema readers. */
export async function prepareDoctorDatabasePreflight(
  options: { scope?: "state"; cfg?: OpenClawConfig; checkSessionIdentity?: boolean } = {},
): Promise<DoctorDatabasePreflight> {
  const { scope } = options;
  const databasePreflight = await import("../state/openclaw-database-preflight.js");
  const [
    { createConfigIO },
    targets,
    { listAgentIds, resolveAgentDir },
    { openDoctorStateSchemaReadAdmission },
  ] = await Promise.all([
    import("../config/io.js"),
    import("../config/sessions/targets.js"),
    import("../agents/agent-scope-config.js"),
    import("../state/openclaw-state-db-doctor-schema.js"),
  ]);
  const snapshot =
    scope === "state" || options.cfg
      ? undefined
      : await createConfigIO({
          env: { ...process.env },
          observe: false,
          pluginValidation: "core-only",
        }).readConfigFileSnapshot();
  const cfg =
    scope === "state" ? undefined : (options.cfg ?? snapshot?.sourceConfig ?? snapshot?.config);
  let agentDatabaseMigrationDiscovery: PreparedAgentDatabaseMigrationDiscovery | undefined;
  const inspectedOwners: { agentId: string; path: string }[] = [];
  const databaseSchemas = await databasePreflight.preflightOpenClawDatabaseSchemas({
    env: process.env,
    scope,
    openStateSchemaReadAdmission: openDoctorStateSchemaReadAdmission,
    onAgentDatabaseOwner:
      options.checkSessionIdentity === false ? undefined : (owner) => inspectedOwners.push(owner),
    ...(cfg
      ? {
          // Custom stores go through the artifact-preserving header reader; discovery
          // must not open live SQLite files before the update guard.
          configuredAgentDatabaseTargets: listAgentIds(cfg).map((agentId) => ({
            agentId,
            path: path.join(resolveAgentDir(cfg, agentId), "openclaw-agent.sqlite"),
          })),
          configuredAgentDatabaseCandidatePaths:
            targets.resolveConfiguredAgentDatabaseCandidatePaths(cfg, { env: process.env }),
          agentAdmissionConfig: cfg,
          onAgentDatabaseDiscovery: (prepared: PreparedAgentDatabaseMigrationDiscovery) => {
            agentDatabaseMigrationDiscovery = prepared;
          },
        }
      : {}),
  });
  if (databaseSchemas.incompatible.length > 0) {
    throw new databasePreflight.OpenClawDatabaseSchemaPreflightError(databaseSchemas.incompatible, {
      operation: "doctor",
    });
  }
  const unreadableStateDatabase = databaseSchemas.indeterminate.find(
    (database) => database.kind === "state",
  );
  if (unreadableStateDatabase) {
    throw new DoctorUnreadableStateDatabaseError(
      unreadableStateDatabase.path,
      unreadableStateDatabase.reason,
    );
  }
  if (cfg && agentDatabaseMigrationDiscovery && options.checkSessionIdentity !== false) {
    const { preflightCanonicalSessionKeys } = await import("./doctor-session-canonical-keys.js");
    const { resolveSqliteTargetFromSessionStorePath } =
      await import("../config/sessions/session-sqlite-target.js");
    const { createOpenClawAgentDatabasePathMatcher } =
      await import("../state/openclaw-agent-db-registry.js");
    const samePath = createOpenClawAgentDatabasePathMatcher();
    const readDatabaseOwner = (pathname: string) =>
      inspectedOwners.find((owner) => samePath(owner.path, pathname))?.agentId;
    const refusedPaths = [
      ...databaseSchemas.indeterminate
        .filter((database) => database.kind === "agent")
        .map((database) => database.path),
      ...(databaseSchemas.agentRefusals ?? []).flatMap((refusal) => refusal.paths),
    ];
    const registeredDatabases = [...agentDatabaseMigrationDiscovery.registeredAgentDatabases];
    for (const owner of inspectedOwners) {
      if (!registeredDatabases.some((registered) => samePath(registered.path, owner.path))) {
        registeredDatabases.push(owner);
      }
    }
    const stores = new Map(
      inspectedOwners
        .filter((target) => !refusedPaths.some((pathname) => samePath(pathname, target.path)))
        .map(({ agentId, path: sqlitePath }) => [
          sqlitePath,
          { agentId, storePath: sqlitePath, sqlitePath },
        ]),
    );
    for (const target of targets.resolveSessionStoreTargets(
      cfg,
      { allAgents: true },
      {
        env: process.env,
        registeredDatabases,
        readDatabaseOwner,
      },
    )) {
      const physical = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        env: process.env,
        registeredDatabases,
        readDatabaseOwner,
      });
      const selectedPath = [...stores.keys()].find((pathname) => samePath(pathname, physical.path));
      if (selectedPath) {
        stores.set(selectedPath, { ...target, sqlitePath: selectedPath });
      }
    }
    await preflightCanonicalSessionKeys({
      cfg,
      env: process.env,
      stores: [...stores.values()],
      registeredDatabases,
      readDatabaseOwner,
    });
  }
  return {
    ...databaseSchemas,
    ...(agentDatabaseMigrationDiscovery ? { agentDatabaseMigrationDiscovery } : {}),
  };
}
