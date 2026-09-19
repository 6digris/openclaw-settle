import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";

export async function assertUpdateBackupWriters(params: {
  root: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { readActiveOpenClawAgentDatabaseLeasesReadOnly } =
    await import("../../state/openclaw-agent-db-lease.js");
  const leases = readActiveOpenClawAgentDatabaseLeasesReadOnly({ env: params.env });
  const firstLease = leases[0];
  if (!firstLease) {
    return;
  }
  const [
    { readActiveGatewayLockIdentity, isSameGatewayLockIdentity },
    { readGatewayServiceState, resolveGatewayService },
    { gatewayServiceCommandUsesRoot },
  ] = await Promise.all([
    import("../../infra/gateway-lock.js"),
    import("../../daemon/service.js"),
    import("./update-command-service-plan.js"),
  ]);
  const refuseWriter = (writer: (typeof leases)[number]): never => {
    throw new Error(
      `Agent ${writer.agent_id} database has an independent or unverified writer in process ${writer.owner_pid}. Update recovery capture must remain available. Stop that writer, then inspect openclaw update status --json and retry; npx openclaw@latest doctor --fix provides explicit recovery.`,
    );
  };
  const gateway = await readActiveGatewayLockIdentity({ env: params.env, requireInspection: true });
  if (!gateway) {
    refuseWriter(firstLease);
  }
  const service = await readGatewayServiceState(resolveGatewayService(), {
    env: params.env,
    requireEffective: true,
  });
  const runtimePid = service.runtime?.pid;
  const launcherStart = runtimePid === undefined ? null : getFileLockProcessStartTime(runtimePid);
  const ownsRoot =
    gateway &&
    (await gatewayServiceCommandUsesRoot({ root: params.root, command: service.command }));
  let ownsGateway = ownsRoot === true && runtimePid === gateway?.pid;
  if (gateway && ownsRoot && runtimePid !== undefined && !ownsGateway && launcherStart !== null) {
    const { readProcessParentPidSync } = await import("../../infra/restart-stale-pids.js");
    const parentPid = readProcessParentPidSync(gateway.pid);
    const currentGateway = await readActiveGatewayLockIdentity({
      env: params.env,
      requireInspection: true,
    });
    // Native managers can track the CLI launcher while its child owns the listener and stores.
    ownsGateway =
      getFileLockProcessStartTime(runtimePid) === launcherStart &&
      currentGateway !== undefined &&
      isSameGatewayLockIdentity(gateway, currentGateway) &&
      currentGateway.pid === gateway.pid &&
      currentGateway.startTime === gateway.startTime &&
      parentPid === runtimePid;
  }
  const unknown = leases.find(
    (lease) =>
      !gateway ||
      !ownsGateway ||
      lease.owner_pid !== gateway.pid ||
      lease.owner_start_time === null ||
      lease.owner_start_time !== gateway.startTime,
  );
  if (unknown) {
    refuseWriter(unknown);
  }
}

/** Exclude new agent opens until irreversible retirement finishes. Existing healthy Gateway
 * handles are allowed; independent handles retain the recovery set. */
export async function withUpdateBackupWriterExclusion<T>(
  params: { root: string; env: NodeJS.ProcessEnv },
  run: (assertOwned: () => void) => Promise<T>,
): Promise<T> {
  const [{ AGENT_DATABASE_MAINTENANCE_LEASE }, { withOpenClawStateLease }] = await Promise.all([
    import("../../state/openclaw-agent-db-lease.js"),
    import("../../state/openclaw-state-lease.js"),
  ]);
  return withOpenClawStateLease(
    {
      ...AGENT_DATABASE_MAINTENANCE_LEASE,
      database: { scope: "shared", options: { env: params.env } },
      leaseMs: 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      leaseLabel: "update capture writer exclusion",
      operationLabel: "update.capture.retirement",
    },
    async (lease) => {
      await assertUpdateBackupWriters(params);
      lease.assertOwned();
      // Lease admission is transactional with agent opens, so the verified set can
      // only shrink until release. Every deletion still checks the live exclusion.
      return run(() => lease.assertOwned());
    },
  );
}
