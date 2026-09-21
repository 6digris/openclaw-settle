// Isolated native Scheduler publication/refresh qualification, not full updater acceptance.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
const [repo, proofRoot, head] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.match(head, /^[a-f0-9]{40}$/);
assert.equal(
  cp.spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  head,
);
await fs.mkdir(proofRoot);
const profile = "pr119052-defaults-" + randomUUID();
const taskName = "OpenClaw Gateway (" + profile + ")";
const digest = (b) => createHash("sha256").update(b).digest("hex");
const receipt = {
  status: "FAIL",
  head,
  driverSha256: digest(await fs.readFile(new URL(import.meta.url))),
  node: process.version,
  platform: process.platform,
  taskName,
  cells: [],
  cleanup: {},
  limitations: [
    "Native Scheduler source-entrypoint refresh/receipt proof with a synthetic task action; not installed-package, real-Gateway or full-updater acceptance.",
  ],
};
const save = () =>
  fs.writeFile(path.join(proofRoot, "defaults.json"), JSON.stringify(receipt, null, 2) + "\n");
let allocated, root, stateDir, reservation;
let stateOwned = false;
let closeStateDatabase = async () => {};
let cleanup = async () => {
  await closeStateDatabase();
  if (reservation?.listening) await new Promise((resolve) => reservation.close(resolve));
  if (stateOwned) await fs.rm(stateDir, { recursive: true, force: true });
  if (allocated) await fs.rm(allocated, { recursive: true, force: true });
  receipt.cleanup = {
    preflightOnly: true,
    stagingRemoved: !allocated || !(await fs.stat(allocated).catch(() => null)),
    errors: [],
  };
};
try {
  allocated = await fs.mkdtemp(path.join(os.tmpdir(), "pr119052-defaults-"));
  root = await fs.realpath(allocated);
  stateDir = path.join(os.userInfo().homedir, ".openclaw-" + profile);
  const actor = path.join(root, "actor.mjs");
  const events = path.join(root, "started.json");
  const platformKeys = new Set([
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "USERNAME",
    "USERDOMAIN",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SYSTEMDRIVE",
    "ALLUSERSPROFILE",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
    "COMMONPROGRAMW6432",
    "PSMODULEANALYSISCACHEPATH",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => platformKeys.has(k.toUpperCase())),
  );
  const temporaryRoot = path.join(root, "temp");
  await fs.mkdir(temporaryRoot);
  Object.assign(env, {
    HOME: os.userInfo().homedir,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_WINDOWS_TASK_NAME: taskName,
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "0",
    APPDATA: path.join(root, "appdata"),
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    NODE_DISABLE_COMPILE_CACHE: "1",
  });
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  const psExe = path.join(
    env.SystemRoot ?? env.SYSTEMROOT,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
  function run(exe, args) {
    const r = cp.spawnSync(exe, args, { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(r.status, 0, r.error?.message ?? r.stderr);
    return r.stdout.trim();
  }
  const ps = (code) =>
    run(psExe, [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from("$ErrorActionPreference='Stop';" + code, "utf16le").toString("base64"),
    ]);
  const task =
    "$s=New-Object -ComObject Schedule.Service;$s.Connect();$f=$s.GetFolder('\\');$t=$f.GetTask(" +
    quote(taskName) +
    ");";
  function absent() {
    return (
      ps(
        "$s=New-Object -ComObject Schedule.Service;$s.Connect();try{$null=$s.GetFolder('\\').GetTask(" +
          quote(taskName) +
          ");'present'}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e.HResult -in @(-2147024894,-2147024893)){'absent'}else{throw}}",
      ) === "absent"
    );
  }
  const effective = () =>
    JSON.parse(
      ps(
        task +
          "$d=$t.Definition;[ordered]@{TriggerEnabled=$d.Triggers.Item(1).Enabled;AllowHardTerminate=$d.Settings.AllowHardTerminate;StartWhenAvailable=$d.Settings.StartWhenAvailable;RunOnlyIfNetworkAvailable=$d.Settings.RunOnlyIfNetworkAvailable;AllowStartOnDemand=$d.Settings.AllowDemandStart;Hidden=$d.Settings.Hidden;RunOnlyIfIdle=$d.Settings.RunOnlyIfIdle;WakeToRun=$d.Settings.WakeToRun;Priority=$d.Settings.Priority;TaskEnabled=$t.Enabled;LogonType=$d.Principal.LogonType;RunLevel=$d.Principal.RunLevel}|ConvertTo-Json -Compress",
      ),
    );
  // Compare the whole native XML policy independently of the product helper.
  // XML formatting is not policy; every node/attribute except the mutable
  // direct Settings.Enabled is retained by System.Xml.
  const taskPolicyXml = (xml) =>
    ps(
      "$d=New-Object System.Xml.XmlDocument;$d.PreserveWhitespace=$false;" +
        "$d.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(" +
        quote(Buffer.from(xml).toString("base64")) +
        ")));if($d.DocumentType){throw 'Unexpected doctype'};" +
        "$n=New-Object System.Xml.XmlNamespaceManager($d.NameTable);" +
        "$n.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task');" +
        "$settings=$d.SelectNodes('/t:Task/t:Settings',$n);" +
        "if($settings.Count -ne 1){throw 'Expected one Task Settings'};" +
        "$enabled=$settings[0].SelectNodes('t:Enabled',$n);" +
        "if($enabled.Count -gt 1){throw 'Duplicate Enabled'};" +
        "if($enabled.Count -eq 1){" +
        "if($enabled[0].Attributes.Count -ne 0 -or $enabled[0].SelectNodes('*').Count -ne 0 -or $enabled[0].InnerText -cnotmatch '^(true|false)$'){throw 'Invalid Enabled'};" +
        "$null=$settings[0].RemoveChild($enabled[0])};$d.OuterXml",
    );
  const expectedDefaults = {
    TriggerEnabled: true,
    AllowHardTerminate: true,
    StartWhenAvailable: false,
    RunOnlyIfNetworkAvailable: false,
    AllowStartOnDemand: true,
    Hidden: false,
    RunOnlyIfIdle: false,
    WakeToRun: false,
    Priority: 7,
  };
  function assertDefaults(values) {
    for (const [key, value] of Object.entries(expectedDefaults))
      assert.equal(values[key], value, key);
    assert.equal(values.LogonType, 3);
    assert.equal(values.RunLevel, 0);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, label) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await fn()) return;
      await sleep(100);
    }
    throw new Error(label);
  }
  async function bindable(port) {
    const server = net.createServer();
    return await new Promise((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
  }
  reservation = net.createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  env.OPENCLAW_GATEWAY_PORT = String(port);
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
  const { closeOpenClawStateDatabaseAsync } = await load("src/state/openclaw-state-db.ts");
  closeStateDatabase = closeOpenClawStateDatabaseAsync;
  const { resolveGatewayService } = await load("src/daemon/service.ts");
  const { withGatewayServiceOperationLock } = await load("src/daemon/service-operation-lock.ts");
  const { captureGatewayServiceDefinitionBackup, restoreGatewayServiceDefinitionBackup } =
    await load("src/daemon/service-definition-backup.ts");
  const { readScheduledTaskDefinition, setScheduledTaskXmlEnabled } = await load(
    "src/daemon/schtasks-control.ts",
  );
  const { resolveTaskScriptPath } = await load("src/daemon/schtasks-layout.ts");
  const service = resolveGatewayService();
  const stdout = new PassThrough();
  stdout.resume();
  const scriptPath = resolveTaskScriptPath(env);
  const owned = new Map();
  function identity(pid) {
    const raw = ps(
      "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " +
        Number(pid) +
        "';if($p){$p|Select-Object ProcessId,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Compress}",
    );
    return raw ? JSON.parse(raw) : null;
  }
  function collectOwned() {
    const raw = ps(
      "@(Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -and ($_.CommandLine.Contains(" +
        quote(actor) +
        ") -or $_.CommandLine.Contains(" +
        quote(scriptPath) +
        "))}|Select-Object ProcessId,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}})|ConvertTo-Json -Compress",
    );
    const values = raw ? JSON.parse(raw) : [];
    for (const row of Array.isArray(values) ? values : [values]) {
      assert.ok(row.ProcessId > 1);
      assert.ok(row.CommandLine.includes(actor) || row.CommandLine.includes(scriptPath));
      const prior = owned.get(row.ProcessId);
      if (prior) assert.deepEqual(prior, row);
      else owned.set(row.ProcessId, row);
    }
  }
  let ownsTask = false;
  cleanup = async () => {
    const errors = [];
    try {
      await closeStateDatabase();
      receipt.cleanup.stateDatabaseClosed = true;
    } catch (e) {
      errors.push(String(e.message));
    }
    if (ownsTask) {
      try {
        collectOwned();
        cp.spawnSync("schtasks.exe", ["/End", "/TN", taskName], {
          env,
          timeout: 30000,
          windowsHide: true,
        });
      } catch (e) {
        errors.push(String(e.message));
      }
      for (const [pid, before] of owned) {
        try {
          const current = identity(pid);
          if (!current) continue;
          assert.deepEqual(current, before, "PID incarnation changed");
          run("taskkill.exe", ["/F", "/T", "/PID", String(pid)]);
        } catch (e) {
          errors.push(String(e.message));
        }
      }
      try {
        await until(() => {
          for (const [pid] of owned) if (identity(pid)) return false;
          return true;
        }, "owned process survived");
        receipt.cleanup.ownProcessesAbsent = true;
      } catch (e) {
        errors.push(String(e.message));
      }
      try {
        if (!absent()) run("schtasks.exe", ["/Delete", "/F", "/TN", taskName]);
        assert.equal(absent(), true);
        receipt.cleanup.taskAbsent = true;
      } catch (e) {
        errors.push(String(e.message));
      }
    }
    try {
      assert.equal(await bindable(port), true);
      receipt.cleanup.portReusable = true;
    } catch (e) {
      errors.push(String(e.message));
    }
    if (errors.length === 0) {
      if (stateOwned) await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
      receipt.cleanup.stateRemoved = !(await fs.stat(stateDir).catch(() => null));
      receipt.cleanup.stagingRemoved = !(await fs.stat(root).catch(() => null));
    }
    receipt.cleanup.errors = errors;
    if (errors.length) receipt.status = "FAIL";
    await save();
  };
  assert.equal(absent(), true);
  await fs.mkdir(stateDir);
  stateOwned = true;
  await fs.writeFile(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({ gateway: { mode: "local", bind: "loopback", port } }) + "\n",
  );
  const configBefore = await fs.readFile(env.OPENCLAW_CONFIG_PATH);
  await fs.writeFile(
    actor,
    `import fs from 'node:fs';import net from 'node:net';const port=Number(process.argv[process.argv.indexOf('--port')+1]);net.createServer(s=>s.end()).listen(port,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(events)},JSON.stringify({pid:process.pid,marker:process.env.OPERATOR_SETTING})));setTimeout(()=>process.exit(0),240000);`,
  );
  const args = {
    env,
    stdout,
    programArguments: [process.execPath, actor, "gateway", "--port", String(port)],
    workingDirectory: root,
    description: "PR119052 defaults baseline",
    environment: {
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_WINDOWS_TASK_NAME: taskName,
      OPERATOR_SETTING: "before-refresh",
    },
  };
  // The unique unregistered name establishes fixture custody before publication.
  ownsTask = true;
  await service.install(args);
  await until(async () => !(await bindable(port)), "baseline listener missing");
  collectOwned();
  assert.equal(JSON.parse(await fs.readFile(events, "utf8")).marker, "before-refresh");
  const originalXml = await readScheduledTaskDefinition(env);
  receipt.taskXml = { original: originalXml };
  assert.match(originalXml, /<Description>PR119052 defaults baseline<\/Description>/u);
  const beforeValues = effective();
  assertDefaults(beforeValues);
  const omitted = [
    "AllowHardTerminate",
    "StartWhenAvailable",
    "RunOnlyIfNetworkAvailable",
    "AllowStartOnDemand",
    "Hidden",
    "RunOnlyIfIdle",
    "WakeToRun",
    "Priority",
  ].filter((k) => !originalXml.includes("<" + k + ">"));
  assert.equal(omitted.length, 8);
  const triggerXml = originalXml.match(/<LogonTrigger>([\s\S]*?)<\/LogonTrigger>/u)?.[1];
  assert.ok(triggerXml);
  assert.doesNotMatch(triggerXml, /<Enabled>/u);
  receipt.cells.push({
    id: "native-export-defaults",
    status: "PASS",
    effective: beforeValues,
    omitted,
    xmlSha256: digest(originalXml),
  });
  await save();
  await service.stop({ env, stdout });
  await until(() => bindable(port), "baseline listener survived stop");
  const originalScript = await fs.readFile(scriptPath);
  await withGatewayServiceOperationLock(env, async (assertCurrent) => {
    const command = await service.readCommand(env, { requireEffective: true });
    assert.ok(command);
    const context = { env, command, assertCurrent };
    const capture = await captureGatewayServiceDefinitionBackup(context);
    await service.install({
      ...args,
      description: "PR119052 defaults refreshed",
      environment: { ...args.environment, OPERATOR_SETTING: "after-refresh" },
      definitionTransaction: capture.hooks,
    });
    await until(async () => {
      try {
        return JSON.parse(await fs.readFile(events, "utf8")).marker === "after-refresh";
      } catch {
        return false;
      }
    }, "refreshed action did not run");
    collectOwned();
    const afterXml = await readScheduledTaskDefinition(env);
    receipt.taskXml.afterRefresh = afterXml;
    assert.match(afterXml, /<Description>PR119052 defaults refreshed<\/Description>/u);
    assert.notEqual(
      setScheduledTaskXmlEnabled(afterXml, false),
      setScheduledTaskXmlEnabled(originalXml, false),
      "refresh must change task policy to exercise definition restoration",
    );
    const afterValues = effective();
    assertDefaults(afterValues);
    const captured = JSON.parse(JSON.stringify(await capture.finish()));
    assert.equal(
      captured.task.afterPolicySha256,
      digest(setScheduledTaskXmlEnabled(afterXml, false)),
    );
    assert.equal(
      (await service.readCommand(env, { requireEffective: true })).environment.OPERATOR_SETTING,
      "after-refresh",
    );
    receipt.cells.push({
      id: "transactional-refresh",
      status: "PASS",
      effective: afterValues,
      receiptPolicy: captured.task.afterPolicySha256,
      originalPolicy: digest(setScheduledTaskXmlEnabled(originalXml, false)),
      taskDefinitionChanged: true,
    });
    await save();
    await service.stop({ env, stdout });
    await until(() => bindable(port), "refreshed listener survived stop");
    receipt.taskXml.afterStop = await readScheduledTaskDefinition(env);
    run("schtasks.exe", ["/Change", "/TN", taskName, "/DISABLE"]);
    receipt.taskXml.afterDisable = await readScheduledTaskDefinition(env);
    receipt.disablePolicy = {
      afterRefresh: digest(setScheduledTaskXmlEnabled(afterXml, false)),
      afterStop: digest(setScheduledTaskXmlEnabled(receipt.taskXml.afterStop, false)),
      afterDisable: digest(setScheduledTaskXmlEnabled(receipt.taskXml.afterDisable, false)),
    };
    await save();
    await restoreGatewayServiceDefinitionBackup({ ...context, receipt: captured });
    assert.deepEqual(await fs.readFile(scriptPath), originalScript);
    assert.deepEqual(await fs.readFile(env.OPENCLAW_CONFIG_PATH), configBefore);
    const restoredXml = await readScheduledTaskDefinition(env);
    const restoredPolicy = taskPolicyXml(restoredXml);
    assert.equal(restoredPolicy, taskPolicyXml(originalXml));
    const restored = effective();
    assertDefaults(restored);
    assert.equal(restored.TaskEnabled, false);
    assert.equal(
      (await service.readCommand(env, { requireEffective: true })).environment.OPERATOR_SETTING,
      "before-refresh",
    );
    assert.equal(await bindable(port), true);
    receipt.cells.push({
      id: "restore-preserves-settings",
      status: "PASS",
      effective: restored,
      definitionRestored: true,
      definitionSha256: digest(restoredPolicy),
      scriptRestored: true,
      configPreserved: true,
      operatorAutostartPreserved: true,
    });
    await save();
  });
  receipt.status = "PASS";
} catch (error) {
  receipt.error = String(error.stack ?? error)
    .replaceAll(root ?? "\0", "<fixture>")
    .replaceAll(stateDir ?? "\0", "<state>");
} finally {
  try {
    await cleanup();
  } catch (error) {
    receipt.cleanup.errors = [...(receipt.cleanup.errors ?? []), String(error.message)];
    receipt.status = "FAIL";
  }
  await save();
}
assert.equal(receipt.status, "PASS", receipt.error ?? JSON.stringify(receipt.cleanup));
