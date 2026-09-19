// Source for the detached helper: notices and mandatory cutover authority stay distinct.
export function buildManagedUpdateCutoverScript(noticeMarker: string): string {
  return String.raw`
let cutover;
let preDrainPrepared = false;

async function prepareCutover() {
  assertGatewayParkOwner();
  if (!cutover) {
    const runtime = await import(pathToFileURL(params.recoveryModulePath).href);
    if (typeof runtime.prepareGatewayUpdateCutover !== "function") {
      throw new Error("Update deferred: the serving runtime cannot prepare a lossless cutover.");
    }
    cutover = await runtime.prepareGatewayUpdateCutover({ expectedPid: params.parentPid, assertCurrent: assertGatewayParkOwner });
  } else if (!preDrainPrepared) await cutover.refresh();
  assertGatewayParkOwner();
  cutover.assertCurrent();
}


let transferPrepared = false;
async function prepareTransferredGateway() {
  if (!transferPrepared) {
    const delayedUntil = Date.now() + params.restartDelayMs;
    while (Date.now() < delayedUntil) {
      if (updateCancelled || nativeCancellation || !ownsManagedUpdateLease()) throw new Error("managed update activation cancelled");
      await sleep(Math.min(250, Math.max(0, delayedUntil - Date.now())));
    }
    // The serving Gateway owns its final notice; the retained control pipe joins
    // that durable write before native stop, without extending the 10s notice bound.
    if (params.beforePark && !process.stdin.destroyed) {
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); finishBeforeParkNotice = undefined; resolve(); };
        const timer = setTimeout(() => {
          appendLog("pre-park notice timed out after 10 seconds");
          finish();
        }, 10_000);
        finishBeforeParkNotice = finish;
        fs.writeSync(1, ${JSON.stringify(noticeMarker)});
      });
    }
  }
  if (params.requester) {
    const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
    if (!(await isManagedUpdateRequesterOwner(params.requester))) {
      throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
    }
  }
  assertGatewayParkOwner();
  transferPrepared = true;
}

async function parkGatewayService() {
  await prepareCutover();
  const recovery = params.serviceRecovery;
  if (!recovery) return;
  assertGatewayParkOwner();
  if (recovery.kind === "schtasks") {
    pendingServiceStop = runServiceCommand("schtasks.exe", ["/End", "/TN", recovery.taskName], () => {
      restorationArmed = true;
      recordServiceStop();
    }, params.parentExitDeadlineAt, params.parentExitTimeoutMs);
    if ((await pendingServiceStop).code !== 0) throw new Error("scheduled task stop failed");
    return;
  }
  if (recovery.kind === "systemd") {
    const current = await inspectSystemdService(recovery.unit, params.parentExitDeadlineAt);
    if (
      !current ||
      current.Id !== recovery.unit ||
      current.LoadState !== "loaded" ||
      current.ActiveState !== "active" ||
      current.MainPID !== String(params.parentPid) ||
      !/^[1-9]\d*$/.test(current.ExecMainStartTimestampMonotonic || "") ||
      !/^[a-f0-9]{32}$/i.test(current.InvocationID || "")) {
      throw new Error("systemd service does not match the exact active gateway parent");
    }
    assertGatewayParkOwner();
    parkedServiceGeneration = current.ExecMainStartTimestampMonotonic;
    parkedServiceInvocation = current.InvocationID;
    parkedServiceFragment = current.FragmentPath;
    // Keep the exact stop job open across parent exit; its completion is the
    // authoritative systemd fact, even after inactive-unit metadata is collected.
    await new Promise((resolve, reject) => {
      pendingServiceStop = runServiceCommand(
        "systemctl",
        ["--user", "stop", recovery.unit],
        () => {
          restorationArmed = true;
          recordServiceStop();
          resolve();
        },
        params.parentExitDeadlineAt,
        params.parentExitTimeoutMs,
      );
      pendingServiceStop.then((result) => {
        if (!restorationArmed) reject(new Error("systemd stop failed: " + result.stderr));
      });
    });
    return;
  }
  if (recovery.kind !== "launchd") throw new Error("unsupported managed update supervisor");
  const target = "gui/" + recovery.uid + "/" + recovery.label;
  const inspection = await runServiceCommand("launchctl", ["print", target], undefined, params.parentExitDeadlineAt);
  const parentMatch = /^\s*pid\s*=\s*([1-9]\d*)\s*$/im.exec(inspection.stdout);
  if (inspection.code !== 0 || Number(parentMatch?.[1]) !== params.parentPid) {
    throw new Error("launchd service does not match the exact active gateway parent");
  }
  assertGatewayParkOwner();
  if (!durableNative) {
    const disabled = await runServiceCommand("launchctl", ["disable", target], () => { restorationArmed = true; }, params.parentExitDeadlineAt);
    if (disabled.code !== 0) throw new Error("launchctl disable failed: " + disabled.stderr);
  }
  assertGatewayParkOwner();
  // bootout shares the activation deadline; its accepted spawn acknowledges parking.
  await new Promise((resolve, reject) => {
    pendingServiceStop = runServiceCommand("launchctl", ["bootout", target], () => { restorationArmed = true; recordServiceStop(); resolve(); }, params.parentExitDeadlineAt);
    pendingServiceStop.then((result) => {
      if (result.code !== 0 && !isLaunchdNotLoaded(result)) {
        reject(new Error("launchctl bootout failed: " + result.stderr));
      }
    });
  });
}

`;
}
