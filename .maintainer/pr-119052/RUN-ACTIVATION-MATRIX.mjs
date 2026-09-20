// Task-private native acceptance driver. Not a product module or a mock Scheduler.
// Run only through RUN-NATIVE-WINDOWS.ps1 on the authorized isolated Windows fixture.
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, proofRoot, expectedHead, selectedCellIds] = process.argv.slice(2);
assert.equal(process.platform, "win32", "Native Windows is required; no simulated pass");
assert.match(expectedHead ?? "", /^[a-f0-9]{40}$/);
const nativeSpawnSync = cp.spawnSync;
const nativeReadFile = fs.readFile.bind(fs);
const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
function ps(script) {
  const result = nativeSpawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop'; " + script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30_000, windowsHide: false });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}
function literal(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(100); }
  throw new Error(message);
}
assert.equal(nativeSpawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), expectedHead);
await fs.mkdir(proofRoot); // Exclusive ownership: existing directories are refused.
const load = (relative) => import(pathToFileURL(path.join(repo, relative)).href);
const { runScheduledTaskOrThrow } = await load("src/daemon/schtasks-control.ts");
const { buildTaskScript, readScheduledTaskCommand, resolveTaskScriptPath } = await load("src/daemon/schtasks-layout.ts");
const { encodeWindowsLauncherScript } = await load("src/infra/windows-launcher-encoding.ts");
const { probeScheduledTaskState } = await load("src/daemon/schtasks-state-probe.ts");
const { readWindowsProcessSnapshot } = await load("src/daemon/schtasks-process.ts");
const { parseCmdScriptCommandLine } = await load("src/daemon/cmd-argv.ts");
const { WINDOWS_TASK_SUPERVISOR_FLAG } = await load("src/daemon/windows-task-supervisor-contract.ts");
const cases = [
  { id: "healthy-fresh", action: "healthy", expected: "scheduled-task" },
  { id: "healthy-existing", action: "healthy", existing: true, expected: "scheduled-task" },
  { id: "degraded-cim-fresh", action: "healthy", degraded: true, expected: "scheduled-task" },
  { id: "degraded-cim-existing", action: "healthy", degraded: true, existing: true, expected: "scheduled-task" },
  { id: "degraded-cim-refusal", action: "noop", degraded: true, expected: "refusal" },
  { id: "foreground-listener", action: "noop", adversary: "listener", expected: "refusal" },
  { id: "exact-child", action: "noop", adversary: "child", expected: "refusal" },
  { id: "exact-supervisor", action: "noop", adversary: "supervisor", expected: "refusal" },
  { id: "preexisting-wrapper", action: "noop", adversary: "wrapper", expected: "refusal" },
  { id: "wrapper-during-preparation", action: "noop", duringRead: "wrapper", expected: "refusal" },
  { id: "transient-running", action: "transient", expected: "refusal" },
  { id: "late-running-healthy", action: "late-healthy", existing: true, expected: "scheduled-task" },
  { id: "late-running-transient", action: "late-transient", existing: true, expected: "refusal" },
  { id: "node-fallback-absent", action: "noop", node: true, expected: "direct-fallback" },
  { id: "node-existing-default-port", action: "noop", node: true, adversary: "child", expected: "refusal" },
  { id: "node-existing-wrapper", action: "noop", node: true, adversary: "wrapper", expected: "refusal" },
  { id: "node-wrapper-during-preparation", action: "noop", node: true, duringRead: "wrapper", expected: "refusal" },
  { id: "node-uninspectable", action: "noop", node: true, degraded: true, expected: "refusal" },
  { id: "cancel-entry", action: "healthy", cancel: "entry", expected: "cancelled" },
  { id: "cancel-during-preparation", action: "healthy", duringRead: "cancel", expected: "cancelled" },
  { id: "cancel-before-mutation", action: "healthy", cancel: "before-run", expected: "cancelled" },
  { id: "cancel-after-mutation", action: "healthy", cancel: "after-run", expected: "cancelled" },
];
const selectedIds = selectedCellIds ? selectedCellIds.split(",") : cases.map(({ id }) => id);
assert.ok(selectedIds.length > 0 && new Set(selectedIds).size === selectedIds.length);
assert.ok(selectedIds.every((id) => cases.some((cell) => cell.id === id)), "Unknown selected native cell");
const selectedCases = cases.filter(({ id }) => selectedIds.includes(id));
const summary = { head: expectedHead, driverSha256: createHash("sha256").update(await nativeReadFile(new URL(import.meta.url))).digest("hex"), platform: process.platform, node: process.version, status: "RUNNING", cells: selectedCases.map(({ id }) => ({ id, status: "UNRUN" })), limitations: ["CIM unavailability is injected by making only the real Win32_Process PowerShell command throw; Scheduler COM, schtasks, task actions, process lifetimes and time are native.", "Late starts use native Scheduler Queue policy: the preceding run exits 13 seconds after /Run; the next native run changes LastRunTime.", "This driver exercises the production activation owner. The maintained lifecycle suite separately covers install/start/restart; no full-CLI or additional teardown-policy proof is inferred."] };
async function save() { await fs.writeFile(path.join(proofRoot, "matrix.json"), JSON.stringify(summary, null, 2) + "\n"); }
await save();
for (const spec of selectedCases) {
  const receipt = summary.cells.find((row) => row.id === spec.id);
  const root = path.join(proofRoot, spec.id);
  await fs.mkdir(root);
  const taskName = "OpenClaw-119052-" + randomUUID();
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const portServer = createServer();
  await new Promise((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const actor = path.join(root, "index.mjs");
  const signal = path.join(root, "mutation.txt");
  const events = path.join(root, "events.jsonl");
  const actionMode = path.join(root, "action-mode.txt");
  const actorSource = `import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import {fileURLToPath} from 'node:url'; import {spawnSync} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url)); const events=path.join(root,'events.jsonl');
const query=spawnSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-Command',"$p=Get-CimInstance Win32_Process -Filter 'ProcessId = "+process.pid+"';$p | Select-Object ProcessId,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress"],{encoding:'utf8',timeout:10000});
if(query.status!==0)throw new Error('Actor native process identity unavailable');const identity=JSON.parse(query.stdout);if(identity.ProcessId!==process.pid||!identity.Created||!identity.CommandLine)throw new Error('Actor identity incomplete');
const emit=(kind)=>fs.appendFileSync(events,JSON.stringify({kind,pid:process.pid,identity,at:Date.now(),argv:process.argv.slice(2)})+'\\n');
const args=process.argv.slice(2); emit('started');
const mode=fs.readFileSync(path.join(root,'action-mode.txt'),'utf8');
if(args[0]==='action') { const countPath=path.join(root,'count.txt'); const count=Number(fs.existsSync(countPath)?fs.readFileSync(countPath,'utf8'):0)+1;fs.writeFileSync(countPath,String(count));emit('action-'+count);
 if(mode==='noop') process.exit(0);
 if(mode==='transient') setTimeout(()=>process.exit(1),1500);
 if(mode.startsWith('late-') && count===1) {const timer=setInterval(()=>{const p=path.join(root,'mutation.txt');if(fs.existsSync(p)&&Date.now()-Number(fs.readFileSync(p,'utf8'))>=13000){clearInterval(timer);process.exit(0)}},50);}
 else if(mode==='late-transient')setTimeout(()=>process.exit(1),1500);
} else if(args.includes('--listen')) {const p=Number(args[args.indexOf('--port')+1]);net.createServer(s=>s.end()).listen(p,'127.0.0.1',()=>emit('listening'));}
setInterval(()=>{},1000); setTimeout(()=>process.exit(2),120000);
`;
  await fs.writeFile(actor, actorSource);
  await fs.writeFile(actionMode, spec.action);
  const env = { ...process.env, OPENCLAW_HOME: undefined, OPENCLAW_PROFILE: "pr119052-" + taskName.slice(-8), OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"), OPENCLAW_WINDOWS_TASK_NAME: taskName, OPENCLAW_SERVICE_KIND: spec.node ? "node" : "gateway", APPDATA: path.join(root, "appdata"), OPENCLAW_TASK_SCRIPT: undefined, OPENCLAW_TASK_SCRIPT_NAME: undefined, OPENCLAW_GATEWAY_PORT: spec.node ? undefined : String(port) };
  const scriptPath = resolveTaskScriptPath(env);
  const installedArgs = [process.execPath, actor, ...(spec.node ? ["node", "run"] : ["gateway", "--port", String(port), ...(spec.adversary === "listener" ? ["--listen"] : [])])];
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, encodeWindowsLauncherScript({ format: "cmd", content: buildTaskScript({ programArguments: installedArgs }) }));
  assert.deepEqual((await readScheduledTaskCommand(env)).programArguments, installedArgs);
  const wrapper = path.join(root, "wrapper.mjs");
  await fs.writeFile(wrapper, "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),120000);");
  const children = [];
  const ownedProcesses = new Map();
  const normalizeArgs = (args) => args.map((arg) => arg.replaceAll("/", "\\").toLowerCase());
  const allowedArgv = [installedArgs, [...installedArgs, WINDOWS_TASK_SUPERVISOR_FLAG], [process.execPath, actor, "action"], [process.execPath, wrapper, scriptPath]].map(normalizeArgs);
  function identity(pid) {
    const text = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}'; if($p){$p | Select-Object ProcessId,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress}`);
    return text ? JSON.parse(text) : null;
  }
  function retainOwnedProcess(pid, eventIdentity) {
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const current = identity(pid);
    if (eventIdentity) {
      assert.equal(eventIdentity.ProcessId, pid);
      assert.ok(eventIdentity.Created && eventIdentity.CommandLine, "Actor event has no native incarnation");
      const recordedArgs = normalizeArgs(parseCmdScriptCommandLine(eventIdentity.CommandLine));
      assert.ok(allowedArgv.some((expected) => JSON.stringify(expected) === JSON.stringify(recordedArgs)), "Event does not name an exact owned actor");
      if (!current || current.Created !== eventIdentity.Created || current.CommandLine !== eventIdentity.CommandLine) {
        (receipt.retiredEventIncarnations ??= []).push(eventIdentity);
        return; // The original incarnation is gone; a reused PID grants no cleanup authority.
      }
    }
    if (!current) return;
    const actual = normalizeArgs(parseCmdScriptCommandLine(current.CommandLine));
    assert.ok(allowedArgv.some((expected) => JSON.stringify(expected) === JSON.stringify(actual)), "PID does not have an exact driver-owned actor/wrapper command");
    const prior = ownedProcesses.get(pid);
    if (prior && !eventIdentity) assert.deepEqual(current, prior, "Owned PID incarnation changed");
    ownedProcesses.set(pid, current);
  }
  const nativeEvents = async () => (await nativeReadFile(events, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  async function startAdversary(kind) {
    const args = kind === "wrapper" ? [wrapper, scriptPath] : [...installedArgs.slice(1), ...(kind === "supervisor" ? [WINDOWS_TASK_SUPERVISOR_FLAG] : [])];
    const child = cp.spawn(process.execPath, args, { env, stdio: "ignore", windowsHide: true });
    children.push(child);
    await until(() => ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; if($p){'yes'}`) === "yes", "Owned adversary failed to start");
    if (kind === "listener") await until(async () => (await nativeEvents()).some((event) => event.kind === "listening"), "Listener not ready");
    retainOwnedProcess(child.pid);
    return child.pid;
  }
  let registered = false, degradedCalls = 0, reads = 0, authorityChecks = 0, revoked = false, mutations = 0, mutationAt;
  const cancellation = new Error("pr119052 exact caller cancellation");
  try {
    // Create only a fresh uniquely named interactive least-privilege current-user task.
    const actionArgs = '"' + actor + '" action';
    ps(`$s=New-Object -ComObject Schedule.Service; $s.Connect();$f=$s.GetFolder('\\');try{$null=$f.GetTask(${literal(taskName)});throw 'Task collision'}catch{if($_.Exception.Message -eq 'Task collision'){throw}};$d=$s.NewTask(0);$d.Principal.LogonType=3;$d.Principal.RunLevel=0;$d.Settings.Enabled=$true;$d.Settings.AllowDemandStart=$true;$d.Settings.DisallowStartIfOnBatteries=$false;$d.Settings.StopIfGoingOnBatteries=$false;$d.Settings.MultipleInstances=1;$d.Settings.ExecutionTimeLimit='PT2M';$a=$d.Actions.Create(0);$a.Path=${literal(process.execPath)};$a.Arguments=${literal(actionArgs)};$a.WorkingDirectory=${literal(root)};$null=$f.RegisterTaskDefinition(${literal(taskName)},$d,2,$null,$null,3)`);
    registered = true;
    const definition = ps(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$s.GetFolder('\\').GetTask(${literal(taskName)}).Xml`);
    if (spec.existing) {
      const initial = nativeSpawnSync("schtasks.exe", ["/Run", "/TN", taskName], { encoding: "utf8", timeout: 15_000 });
      assert.equal(initial.status, 0);
      await until(() => probeScheduledTaskState(taskName).state === 4, "Existing native task never became Running");
      await until(async () => (await nativeEvents()).some((event) => event.kind === "action-1"), "Existing native action never started");
    }
    if (spec.adversary) receipt.adversaryPid = await startAdversary(spec.adversary);
    for (const event of await nativeEvents()) retainOwnedProcess(event.pid, event.identity);
    const before = probeScheduledTaskState(taskName);
    receipt.before = before;
    if (spec.degraded) {
      cp.spawnSync = function(executable, args, options) {
        if (args?.some((arg) => String(arg).includes("Get-CimInstance Win32_Process"))) {
          degradedCalls++;
          return nativeSpawnSync(executable, args.map((arg) => String(arg).includes("Get-CimInstance Win32_Process") ? "function Get-CimInstance { throw 'pr119052 injected CIM unavailable' }; " + arg : arg), options);
        }
        return nativeSpawnSync(executable, args, options);
      };
      syncBuiltinESMExports();
      assert.equal(readWindowsProcessSnapshot(), null, "Fault injection must really fail the CIM command");
      assert.equal(probeScheduledTaskState(taskName).status, "found", "COM must remain native and available");
      degradedCalls = 0; // Only candidate-path calls count as degraded-CIM coverage.
    }
    if (spec.duringRead) {
      fs.readFile = async function(target, ...rest) {
        const result = await nativeReadFile(target, ...rest);
        if (String(target) === scriptPath && reads++ === 0) {
          if (spec.duringRead === "wrapper") receipt.adversaryPid = await startAdversary("wrapper");
          else revoked = true;
        }
        return result;
      };
    }
    const started = Date.now();
    let outcome;
    try {
      outcome = await runScheduledTaskOrThrow({ taskName, env, scriptPath,
        assertCurrent() { authorityChecks++; if (revoked || (spec.cancel === "entry" && authorityChecks === 1) || (spec.cancel === "before-run" && authorityChecks === 2)) throw cancellation; },
        onMutation() { mutations++; mutationAt = Date.now(); writeFileSync(signal, String(mutationAt)); if (spec.cancel === "after-run") revoked = true; },
      });
    } catch (error) {
      if (error === cancellation) outcome = "cancelled";
      else if (/refusing a direct fallback/.test(error.message)) outcome = "refusal";
      else throw error;
    }
    const ended = Date.now();
    receipt.elapsedMs = ended - started;
    receipt.mutationToReturnMs = mutationAt === undefined ? null : ended - mutationAt;
    receipt.actual = outcome;
    receipt.authorityChecks = authorityChecks;
    receipt.mutations = mutations;
    receipt.degradedNativeCommands = degradedCalls;
    receipt.after = probeScheduledTaskState(taskName);
    assert.equal(outcome, spec.expected);
    if (spec.degraded) assert.ok(degradedCalls > 0, "Activation itself must encounter the real injected CIM failure");
    if (receipt.adversaryPid) {
      assert.deepEqual(identity(receipt.adversaryPid), ownedProcesses.get(receipt.adversaryPid), "Activation must preserve the pre-existing exact process incarnation");
      receipt.adversaryPreserved = true;
      receipt.assertedContract = spec.node ? "A real pre-existing node/wrapper blocks otherwise permitted direct fallback" : "A real pre-existing gateway/listener/wrapper must not substitute for Scheduler supervision; this is not a PID-detector coverage claim";
    }
    if (spec.cancel === "after-run") {
      assert.equal(mutations, 1, "Cancellation follows exactly one actual /Run mutation");
      await until(async () => (await nativeEvents()).some((event) => event.kind === "action-1"), "After-run cancellation requires a real native task action");
      assert.notEqual(probeScheduledTaskState(taskName).lastRunTime, before.lastRunTime);
    }
    if (spec.action.startsWith("late-")) {
      assert.ok((await nativeEvents()).some((event) => event.kind === "action-2"), "Native queued second run must actually execute");
      assert.notEqual(receipt.after.lastRunTime, before.lastRunTime);
      assert.ok(receipt.mutationToReturnMs !== null);
      if (spec.expected === "scheduled-task") assert.ok(receipt.mutationToReturnMs >= 28_000, "Preparation time must not count toward the late start's full settling interval");
      // Owner bound: 30s startup + settling, one 5s COM probe, one 250ms poll.
      assert.ok(receipt.mutationToReturnMs <= 35_250, "Late-run verification exceeded the owner deadline plus native probe allowance");
    }
    if (outcome === "scheduled-task") assert.equal(receipt.after.state, 4);
    if (outcome === "direct-fallback") await until(async () => (await nativeEvents()).some((event) => event.argv[0] === "node"), "Fallback did not launch real node-shaped actor");
    if (outcome === "cancelled" && spec.cancel !== "after-run") {
      assert.equal(mutations, 0); assert.equal(receipt.after.lastRunTime, before.lastRunTime);
      assert.equal((await nativeEvents()).length, 0);
    }
    if (outcome === "refusal" && spec.node) assert.equal((await nativeEvents()).filter((event) => event.argv[0] === "node").length, spec.adversary === "child" ? 1 : 0, "No duplicate fallback is permitted");
    assert.equal(ps(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$s.GetFolder('\\').GetTask(${literal(taskName)}).Xml`), definition);
    receipt.status = "PASS_PENDING_CLEANUP";
  } catch (error) {
    receipt.status = "FAIL"; receipt.error = String(error.stack ?? error);
  } finally {
    cp.spawnSync = nativeSpawnSync; syncBuiltinESMExports(); fs.readFile = nativeReadFile;
    try {
      if (registered) {
        nativeSpawnSync("schtasks.exe", ["/End", "/TN", taskName], { encoding: "utf8", timeout: 15_000 });
        ps(`$s=New-Object -ComObject Schedule.Service;$s.Connect();$s.GetFolder('\\').DeleteTask(${literal(taskName)},0)`);
        assert.equal(probeScheduledTaskState(taskName).status, "missing");
      }
      // Event PIDs come only from this driver's generated actors; direct children
      // are retained at spawn. A directory mention is diagnostic, never kill authority.
      for (const event of await nativeEvents()) retainOwnedProcess(event.pid, event.identity);
      for (const [pid, expected] of ownedProcesses) {
        const current = identity(pid);
        if (!current) continue;
        if (current.Created !== expected.Created || current.CommandLine !== expected.CommandLine) {
          (receipt.retiredCleanupIncarnations ??= []).push(expected);
          continue; // The exact owned incarnation exited; preserve its unrelated PID successor.
        }
        ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($p){if($p.CreationDate.ToUniversalTime().ToString('o') -ne ${literal(expected.Created)} -or $p.CommandLine -cne ${literal(expected.CommandLine)}){throw 'Cleanup identity changed'};Stop-Process -Id ${pid} -Force -ErrorAction Stop}`);
      }
      await until(() => ps(`$p=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${literal(root)}) -and $_.ProcessId -ne $PID });$p.Count`) === "0", "Owned processes remain after cleanup");
      const server = createServer();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve) => server.close(resolve));
      receipt.cleanup = { taskAbsent: true, ownProcessesAbsent: true, portRebound: true };
      receipt.events = await nativeEvents();
      if (receipt.status === "PASS_PENDING_CLEANUP") receipt.status = "PASS";
    } catch (error) { receipt.cleanupError = String(error.stack ?? error); receipt.status = "FAIL"; }
    await save();
  }
  // Stop after a failed cell so the fixture owner can inspect exact native evidence.
  if (receipt.status !== "PASS") break;
}
summary.status = summary.cells.every((cell) => cell.status === "PASS") ? "PASS" : "INCOMPLETE";
await save();
if (summary.status !== "PASS") process.exitCode = 1;
