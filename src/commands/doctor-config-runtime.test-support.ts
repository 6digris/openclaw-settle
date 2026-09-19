// Fresh Doctor script processes share compiled config and install-index module identities.
export const doctorConfigRuntimeEntrypoints = {
  configIO: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/io",
    distWorkerPath: "config/io.js",
  },
  preflight: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-config-preflight",
    distWorkerPath: "commands/doctor-config-preflight.js",
  },
  checkpoint: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/startup-migration-checkpoint",
    distWorkerPath: "infra/startup-migration-checkpoint.js",
  },
  configGuard: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/program/config-guard",
    distWorkerPath: "cli/program/config-guard.js",
  },
  runtime: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../runtime",
    distWorkerPath: "runtime.js",
  },
  configFlow: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-config-flow",
    distWorkerPath: "commands/doctor-config-flow.js",
  },
  metadataSnapshot: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/current-plugin-metadata-snapshot",
    distWorkerPath: "plugins/current-plugin-metadata-snapshot.js",
  },
  stateHealth: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../flows/doctor-health-contribution-runners.state",
    distWorkerPath: "flows/doctor-health-contribution-runners.state.js",
  },
  prompter: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-prompter",
    distWorkerPath: "commands/doctor-prompter.js",
  },
  configHealth: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../flows/doctor-health-contribution-runners.config",
    distWorkerPath: "flows/doctor-health-contribution-runners.config.js",
  },
  installIndexSeed: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../plugins/test-helpers/installed-plugin-index",
    distWorkerPath: "test-support/installed-plugin-index.js",
  },
} as const;

// Recovery producers use the same invocation-owned compiled graph as Doctor fixtures.
export const doctorRecoveryRuntimeEntrypoints = {
  executor: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/update-cli/update-command-executor",
    distWorkerPath: "cli/update-cli/update-command-executor.js",
  },
  backup: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../cli/update-cli/update-command-backup-lifecycle",
    distWorkerPath: "cli/update-cli/update-command-backup-lifecycle.js",
  },
  ledger: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-run-ledger",
    distWorkerPath: "infra/update-run-ledger.js",
  },
  recovery: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../infra/update-recovery-backup",
    distWorkerPath: "infra/update-recovery-backup.js",
  },
  maintenance: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "doctor-maintenance",
    distWorkerPath: "commands/doctor-maintenance.js",
  },
  sessions: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/session-accessor",
    distWorkerPath: "config/sessions/session-accessor.js",
  },
  sessionPaths: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../config/sessions/paths",
    distWorkerPath: "config/sessions/paths.js",
  },
  agentDatabases: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../state/openclaw-agent-db-lifecycle",
    distWorkerPath: "state/openclaw-agent-db-lifecycle.js",
  },
  stateDatabase: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../state/openclaw-state-db",
    distWorkerPath: "state/openclaw-state-db.js",
  },
} as const;
