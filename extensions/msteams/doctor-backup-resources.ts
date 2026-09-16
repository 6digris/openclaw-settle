import path from "node:path";
import type { PluginDoctorMigrationBackupResource } from "openclaw/plugin-sdk/runtime-doctor-migrations";
export function stateFileBackupResources(
  stateDir: string,
  filename: string,
): PluginDoctorMigrationBackupResource[] {
  const filePath = path.join(stateDir, filename);
  return [
    { path: filePath, kind: "file" },
    { path: `${filePath}.migrated`, kind: "file" },
  ];
}
