import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  migrateOpenClawAgentDatabaseForMaintenance,
  withAgentDatabaseMaintenanceLease,
} from "../state/openclaw-agent-db.js";
import { hasPendingTranscriptFtsMappings } from "../state/openclaw-agent-transcript-fts-schema.js";
import type { ExistingAgentDatabaseTarget } from "./doctor-session-sqlite-readers.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

function needsPreparation(pathname: string): boolean {
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return hasPendingTranscriptFtsMappings(database);
  } finally {
    database.close();
  }
}

/** Repair already-migrated stores too; their schema version cannot certify FTS ownership. */
export async function prepareDoctorSessionTranscriptFts(params: {
  env: NodeJS.ProcessEnv;
  targets: readonly ExistingAgentDatabaseTarget[];
  authority: DoctorSqliteMaintenanceAuthority | undefined;
}): Promise<number> {
  const authority = params.authority;
  if (!authority) {
    throw new Error("Transcript search preparation requires Doctor maintenance ownership");
  }
  authority.assertCurrent();
  const pending = params.targets.filter((target) => needsPreparation(target.sqlitePath));
  if (!pending.length) {
    return 0;
  }
  await withAgentDatabaseMaintenanceLease({ env: params.env }, async (maintenance) => {
    for (const target of pending) {
      authority.assertCurrent();
      await migrateOpenClawAgentDatabaseForMaintenance(
        {
          agentId: target.agentId,
          pathname: target.sqlitePath,
        },
        maintenance,
      );
      authority.assertCurrent();
      if (needsPreparation(target.sqlitePath)) {
        throw new Error("Legacy transcript search ownership was not prepared by Doctor");
      }
    }
  });
  authority.assertCurrent();
  return pending.length;
}
