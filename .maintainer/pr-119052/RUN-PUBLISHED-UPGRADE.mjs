import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

assert.equal(process.platform, "win32", "Native Windows is mandatory");
const [packageFile, packageHash, candidateSha, npmCli, proofDir] = process.argv.slice(2);
assert.match(packageHash, /^[a-f0-9]{64}$/);
assert.equal(candidateSha, "6f9e6ba62855e0cc7824708d2a2e4484a2123aa9");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const driverHash = sha256(await fs.readFile(new URL(import.meta.url)));
assert.equal(sha256(await fs.readFile(packageFile)), packageHash);
await fs.mkdir(proofDir, { recursive: false });
const allocatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pr119052-published-"));
const root = await fs.realpath(allocatedRoot);
const temporaryRoot = path.join(root, "temp");
await fs.mkdir(temporaryRoot);
const profile = "pr119052-upgrade-" + randomBytes(6).toString("hex");
const stateDir = path.join(os.userInfo().homedir, ".openclaw-" + profile);
const prefix = path.join(root, "prefix");
const entry = path.join(prefix, "node_modules", "openclaw", "openclaw.mjs");
const taskName = "OpenClaw Gateway (" + profile + ")";
const token = randomBytes(32).toString("hex");
const platformEnvKeys = new Set([
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
  "LOCALAPPDATA", "PROGRAMDATA", "USERNAME", "USERDOMAIN", "HOMEDRIVE", "HOMEPATH",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "SYSTEMDRIVE", "ALLUSERSPROFILE", "PROGRAMW6432", "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PSMODULEANALYSISCACHEPATH"
]);
const platformEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => platformEnvKeys.has(key.toUpperCase())));
const env = { ...platformEnv, OPENCLAW_PROFILE: profile, OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"), APPDATA: path.join(root, "appdata"),
  NPM_CONFIG_PREFIX: prefix, npm_config_prefix: prefix, NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
  TEMP: temporaryRoot, TMP: temporaryRoot,
  NODE_DISABLE_COMPILE_CACHE: "1", OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
  PATH: prefix + path.delimiter + process.env.PATH };
for (const key of ["OPENCLAW_HOME", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD",
  "NODE_OPTIONS", "NODE_COMPILE_CACHE", "GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) delete env[key];
const receipt = { status: "FAIL", product: candidateSha, baseline: "2026.9.5",
  packageHash, driverHash, taskName, childEnvKeys: Object.keys(env).sort(), cells: [], cleanup: {}, limitations: [
    "Rejected-activation recovery is a separate installed-candidate service cell, not published-updater rollback.",
    "No inference provider or foreground Gateway substitutes for Scheduled Task health."
  ] };
const psQuote = v => "'" + v.replaceAll("'", "''") + "'";
const redact = text => String(text).replaceAll(token, "<test-token>").replaceAll(stateDir, "<state>")
  .replaceAll(root, "<root>").replaceAll(os.userInfo().homedir, "<account-home>");
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Diagnostics are projections only: never emit arguments, environment values,
// configs, ledger details/origin/targets, SQL rows, or arbitrary HTTP paths.
let diagnosticCount = 0;
function diagnostic(event) {
  if (diagnosticCount++ >= 2048) return;
  appendFileSync(path.join(proofDir, "progress.log"), JSON.stringify({ at: Date.now(), ...event }) + "\n");
}
const knownSteps = new Set([
  "requested", "driver:adopted", "installation-inspection", "target-resolution", "disk-space-preflight",
  "global update", "global install", "npm install", "fetch", "build", "snapshot", "stage", "install",
  "Checking update runtime", "Preparing update checks", "Checking data migrations", "Checking update health",
  "Checking configuration", "Checking plugins", "Checking update recovery", "Checking Gateway startup",
  "managed-service update handoff", "post-update verification", "gateway verification", "package rollback"
]);
const enumValue = (value, allowed) => allowed.includes(value) ? value : "unknown";
const integer = value => Number.isSafeInteger(value) ? value : null;
async function sampleUpdateLedger() {
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  let db;
  try {
    await fs.access(file);
    db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
    const rows = db.prepare(`SELECT created_at_ms, updated_at_ms, phase, status,
      CASE WHEN length(steps_json) <= 16384 THEN steps_json ELSE '[]' END AS steps_json
      FROM update_runs ORDER BY created_at_ms DESC LIMIT 2`).all();
    diagnostic({ kind: "ledger", rows: rows.map(row => ({
      createdAtMs: integer(row.created_at_ms), updatedAtMs: integer(row.updated_at_ms),
      phase: enumValue(row.phase, ["requested", "staging", "validating", "repairing", "activating", "restarting", "verifying", "finished"]),
      status: enumValue(row.status, ["running", "succeeded", "failed", "rolled-back", "skipped"]),
      steps: (() => {
        const steps = JSON.parse(row.steps_json);
        return Array.isArray(steps) ? steps.slice(-32).map(step => ({
          step: knownSteps.has(step?.step) ? step.step : "unlisted",
          stepHash: typeof step?.step === "string" ? sha256(step.step) : null,
          status: enumValue(step?.status, ["pending", "in_progress", "completed", "failed", "skipped"]),
          startedAtMs: integer(step?.startedAtMs), endedAtMs: integer(step?.endedAtMs)
        })) : [];
      })()
    })) });
  } catch (error) {
    diagnostic({ kind: "ledger-unavailable", code: enumValue(error.code,
      ["ENOENT", "EACCES", "EPERM", "ERR_SQLITE_ERROR", "ERR_SQLITE_BUSY"]) });
  } finally { db?.close(); }
}
let commandSequence = 0;
async function run(exe, args, label, { timeout = 180000, check = true, childEnv = env } = {}) {
  const began = Date.now();
  const sequence = ++commandSequence;
  const child = spawn(exe, args, { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  diagnostic({ kind: "command-start", sequence, label, pid: child.pid ?? null, timeoutMs: timeout });
  let output = "", stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", b => { const text=b.toString(); stdout+=text; output+=text; });
  child.stderr.on("data", b => { const text=b.toString(); stderr+=text; output+=text; });
  const timer = setTimeout(() => {
    timedOut = true;
    diagnostic({ kind: "command-timeout", sequence, label, elapsedMs: Date.now() - began });
    child.kill();
  }, timeout);
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
    .finally(() => clearTimeout(timer));
  const elapsedMs = Date.now() - began;
  diagnostic({ kind: "command-end", sequence, label, code, timedOut, elapsedMs });
  if (label === "published-update") receipt.update = { code, timedOut, elapsedMs, timeoutMs: timeout };
  await fs.writeFile(path.join(proofDir, String(sequence).padStart(3, "0") + "-" + label + ".log"), redact(output));
  assert(!timedOut, label + " timed out");
  if (check) assert.equal(code, 0, label + " failed; inspect sanitized command log");
  return { code, output, stdout, stderr, elapsedMs };
}
const ps = (script, label) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from("$ErrorActionPreference='Stop'; " + script, "utf16le").toString("base64")], label);
const cli = (args, label, options) => run(process.execPath, [entry, ...args], label, options);
function jsonOutput(output) {
  const text = output.trim();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    try { return JSON.parse(text.slice(i)); } catch {}
  }
  throw new Error("Missing complete JSON command output");
}
async function task() {
  const result = await ps([
    "$s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\')",
    "try { $t=$f.GetTask(" + psQuote(taskName) + ") } catch {",
    "if ($_.Exception.HResult -eq -2147024894) { '{\"exists\":false}'; exit 0 }; throw }",
    "$d=$t.Definition; [xml]$xml=$t.Xml",
    "@{ exists=$true; state=[int]$t.State; enabled=[bool]$t.Enabled; logon=[int]$d.Principal.LogonType;",
    "level=[int]$d.Principal.RunLevel; user=[string]$d.Principal.UserId; settings=[string]$xml.Task.Settings.OuterXml;",
    "triggers=[string]$xml.Task.Triggers.OuterXml; xml=[string]$t.Xml } | ConvertTo-Json -Compress"
  ].join("\n"), "task");
  return jsonOutput(result.stdout);
}
function settings(t) {
  return { enabled: t.enabled, logon: t.logon, level: t.level, user: t.user,
    settings: t.settings, triggers: t.triggers };
}
async function ownedProcesses() {
  // Match whole executable arguments, not a broad root-directory substring.
  const allowed = [entry, path.join(prefix, "node_modules", "openclaw", "dist", "index.js"),
    path.join(prefix, "node_modules", "openclaw", "dist", "index.mjs"),
    path.join(stateDir, "gateway.cmd"), path.join(stateDir, "gateway.vbs")];
  const result = await ps([
    "$paths=@(" + allowed.map(psQuote).join(",") + ")",
    "$rows=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='cmd.exe' OR Name='wscript.exe' OR Name='cscript.exe' OR Name='cmd.exe' OR Name='wscript.exe' OR Name='cscript.exe'\" | Where-Object {",
    "$c=$_.CommandLine; $matched=$false",
    "foreach($p in $paths) { if ($c -match ('(^|\\s)\"*' + [regex]::Escape($p) + '\"*(\\s|$)')) { $matched=$true } }; $matched",
    "} | ForEach-Object { @{ pid=[int]$_.ProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o') } })",
    "ConvertTo-Json -InputObject $rows -Compress"
  ].join("\n"), "owned-processes");
  return JSON.parse(result.stdout.trim());
}
async function bindable(port) {
  const s = net.createServer();
  return await new Promise(resolve => {
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
const portServer = net.createServer();
await new Promise((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
const port = portServer.address().port;
await new Promise(r => portServer.close(r));
env.OPENCLAW_GATEWAY_PORT = String(port);
receipt.childEnvKeys = Object.keys(env).sort();
let server, savedScript, scriptPath, taskBefore;
let taskAdmitted = false, stateOwned = false;
const observedOwners = new Map();
async function taskListenerOwnership(pid) {
  const wrappers = [path.join(stateDir, "gateway.cmd"), path.join(stateDir, "gateway.vbs")];
  const result = await ps([
    "$s=New-Object -ComObject Schedule.Service; $s.Connect(); $t=$s.GetFolder('\\').GetTask(" + psQuote(taskName) + ")",
    "$instances=@($t.GetInstances(0)); if ($instances.Count -ne 1 -or $t.State -ne 4) { throw 'Task lacks one running instance' }",
    "$instance=$instances[0]; $engine=[int]$instance.EnginePID; if ($engine -le 1) { throw 'Task engine PID unavailable' }",
    "$listeners=@(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort " + port + " -ErrorAction Stop)",
    "if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne " + pid + ") { throw 'Reported Gateway PID is not the authenticated listener' }",
    "$all=@{}; Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $all[[int]$_.ProcessId]=$_ }",
    "$cursor=" + pid + "; $seen=@{}; $chain=@(); $scriptSeen=$false; $engineSeen=$false; $newer=$null",
    "$paths=@(" + wrappers.map(psQuote).join(",") + ")",
    "while ($cursor -gt 1 -and -not $seen.ContainsKey($cursor)) {",
    "  $seen[$cursor]=$true; $process=$all[$cursor]; if (-not $process) { throw 'Process ancestry unavailable' }",
    "  if ($newer -and $process.CreationDate -gt $newer) { throw 'Parent PID was recycled' }; $newer=$process.CreationDate",
    "  $ownScript=$false; foreach($file in $paths) { if ($process.CommandLine -match ('(^|\\s)\"*' + [regex]::Escape($file) + '\"*(\\s|$)')) { $ownScript=$true } }",
    "  $scriptSeen=$scriptSeen -or $ownScript; $isEngine=$cursor -eq $engine; $engineSeen=$engineSeen -or $isEngine",
    "  $chain+=@{ pid=$cursor; parent=[int]$process.ParentProcessId; created=$process.CreationDate.ToUniversalTime().ToString('o'); ownScript=$ownScript; engine=$isEngine }",
    "  if ($isEngine) { break }; $cursor=[int]$process.ParentProcessId",
    "}",
    "if (-not $engineSeen -or -not $scriptSeen) { throw 'Listener is not a descendant of this task action and engine' }",
    "$again=@($t.GetInstances(0)); if ($t.State -ne 4 -or $again.Count -ne 1 -or $again[0].InstanceGuid -cne $instance.InstanceGuid -or $again[0].EnginePID -ne $engine) { throw 'Task instance changed during ownership observation' }",
    "@{ instance=[string]$instance.InstanceGuid; engine=$engine; listener=" + pid + "; chain=$chain } | ConvertTo-Json -Depth 8 -Compress"
  ].join("\n"), "listener-task-ownership");
  const ownership = jsonOutput(result.stdout);
  for (const owner of ownership.chain) {
    if (!owner.engine || owner.ownScript) observedOwners.set(owner.pid + ":" + owner.created, owner);
  }
  return ownership;
}
async function candidateBuildEvidence(label, expectedBuildId) {
  assert.equal(typeof expectedBuildId, "string", "Candidate build fingerprint missing");
  const liveProbe = jsonOutput((await cli(["gateway", "probe", "--port", String(port), "--json", "--timeout", "15000"], label)).stdout);
  const selected = liveProbe.targets?.find(target => target.url === "ws://127.0.0.1:" + port);
  assert(selected?.connect?.rpcOk, "Candidate fingerprint lacks authenticated RPC proof");
  assert.equal(selected.server?.buildId, expectedBuildId, "Running Gateway build is not the candidate");
  return selected.server.buildId;
}
async function healthy(label, previousPid) {
  const deadline = Date.now() + 180000;
  let status;
  do {
    const result = await cli(["gateway", "status", "--deep", "--require-rpc", "--json"], label, { check: false, timeout: 60000 });
    try { status = jsonOutput(result.stdout); } catch {}
    if (result.code === 0 && status?.rpc?.ok && status?.service?.runtime?.status === "running" &&
        Number.isSafeInteger(status.service.runtime.pid) && status.service.runtime.pid > 1 &&
        status.service.runtime.pid !== previousPid) {
      const native = await task();
      assert.equal(native.state, 4, "RPC health alone cannot establish Scheduler Running");
      return { pid: status.service.runtime.pid, rpc: true, scheduler: native.state,
        ownership: await taskListenerOwnership(status.service.runtime.pid) };
    }
    await sleep(1000);
  } while (Date.now() < deadline);
  throw new Error(label + " never established authenticated RPC and Scheduler Running");
}
try {
  assert.equal((await task()).exists, false, "Refuse existing fixture task");
  taskAdmitted = true;
  await fs.mkdir(stateDir);
  stateOwned = true;
  await fs.mkdir(prefix);
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify({
    gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token } }
  }) + "\n");
  // Native diagnostic only: reproduce the published absence probe in the same
  // child-console context before the expensive baseline installation. No runtime
  // hook or probe substitution is installed in the released CLI.
  const probeScript = [
    "$ErrorActionPreference='Stop'",
    "$taskName=" + psQuote(taskName),
    "$lookup=$false",
    "try { $service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $lookup=$true; $task=$service.GetFolder('\\').GetTask($taskName); $lookup=$false } catch { $exception=$_.Exception; while($null -ne $exception.InnerException){$exception=$exception.InnerException}; Write-Output $exception.HResult; if($lookup){exit 1}; exit 2 }",
    "exit 0"
  ].join("; ");
  const probeCode = `import {spawnSync} from 'node:child_process';
    const r=spawnSync(${JSON.stringify(path.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))},
      ['-NoProfile','-NonInteractive','-EncodedCommand',${JSON.stringify(Buffer.from(probeScript, "utf16le").toString("base64"))}],
      {env:process.env,encoding:'utf8',timeout:5000,windowsHide:false});
    console.log(JSON.stringify({status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.code || null}));`;
  const addedBootstrapKeys = new Set(["SYSTEMDRIVE", "ALLUSERSPROFILE", "PROGRAMW6432",
    "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PSMODULEANALYSISCACHEPATH"]);
  const legacyEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !addedBootstrapKeys.has(key.toUpperCase())));
  const legacyProbe = jsonOutput((await run(process.execPath, ["--input-type=module", "-e", probeCode],
    "legacy-bootstrap-probe", {childEnv:legacyEnv})).stdout);
  const nativeProbe = jsonOutput((await run(process.execPath, ["--input-type=module", "-e", probeCode],
    "native-bootstrap-probe")).stdout);
  receipt.nativeBootstrap = {legacy:legacyProbe,qualified:nativeProbe};
  assert.equal(nativeProbe.error, null, "Published native probe could not execute");
  assert.equal(nativeProbe.status, 1, "Native probe did not establish missing-task result");
  assert([-2147024894, -2147024893].includes(Number(nativeProbe.stdout.trim())),
    "Native probe did not establish exact task absence");
  const packed = await run(process.execPath, [npmCli, "pack", "openclaw@2026.9.5", "--json",
    "--ignore-scripts", "--min-release-age=0", "--pack-destination", root], "fetch-published", { timeout: 600000 });
  const metadata = JSON.parse(packed.stdout.trim());
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].version, "2026.9.5");
  assert.equal(metadata[0].integrity, "sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w==", "Published release digest changed");
  assert.equal(path.basename(metadata[0].filename), metadata[0].filename);
  const baselineFile = path.join(root, metadata[0].filename);
  const baselineBytes = await fs.readFile(baselineFile);
  assert.equal("sha512-" + createHash("sha512").update(baselineBytes).digest("base64"), metadata[0].integrity);
  receipt.baselinePackage = { sha256: sha256(baselineBytes), integrity: metadata[0].integrity };
  await run(process.execPath, [npmCli, "install", "--global", "--prefix", prefix, baselineFile,
    "--no-audit", "--no-fund"], "install-published", { timeout: 1200000 });
  const packageJson = path.join(prefix, "node_modules", "openclaw", "package.json");
  assert.equal(JSON.parse(await fs.readFile(packageJson, "utf8")).version, "2026.9.5");
  const baselineReference = path.join(root, "published-reference");
  await fs.mkdir(baselineReference);
  await run("tar.exe", ["-xzf", baselineFile, "-C", baselineReference], "extract-published-reference");
  async function runtimeInventory(packageRoot) {
    const files = [];
    async function collect(relative) {
      const absolute = path.join(packageRoot, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        files.push([relative, "directory"]);
        for (const name of (await fs.readdir(absolute)).sort()) await collect(path.join(relative, name));
      } else { assert(stat.isFile(), "Unexpected runtime link"); files.push([relative, "file", sha256(await fs.readFile(absolute))]); }
    }
    for (const relative of ["openclaw.mjs", "dist", "dist-runtime"]) {
      if (await fs.lstat(path.join(packageRoot, relative)).catch(error => {
        if (error.code === "ENOENT") return null; throw error;
      })) await collect(relative);
    }
    return files;
  }
  const baselineFiles = await runtimeInventory(path.join(baselineReference, "package"));
  assert(baselineFiles.length > 10, "Published runtime inventory missing");
  async function verifyPublishedRuntime() {
    assert.deepEqual(await runtimeInventory(path.join(prefix, "node_modules", "openclaw")), baselineFiles,
      "Installed published updater runtime differs from complete released tree");
  }
  await verifyPublishedRuntime();
  receipt.publishedRuntimeTreeSha256 = sha256(JSON.stringify(baselineFiles));
  receipt.publishedEntrySha256 = sha256(await fs.readFile(entry));
  // Exercise the exact installed published durability helper; this is not a
  // replacement for the updater's own checks and does not alter release bytes.
  const durabilityCode = `import fs from 'node:fs/promises';
    import {createRequire} from 'node:module'; import path from 'node:path';
    const require=createRequire(${JSON.stringify(entry)});
    const helperPath=require.resolve('@openclaw/fs-safe/durability');
    const helperPackage=JSON.parse(await fs.readFile(path.join(path.dirname(helperPath),'..','package.json'),'utf8'));
    if(helperPackage.version!=='0.13.1') throw new Error('Unexpected published durability version');
    const {syncDirectory}=require('@openclaw/fs-safe/durability');
    const directory=path.join(process.env.TEMP,'openclaw');
    await fs.mkdir(directory,{recursive:true});
    const canonical=await fs.realpath(directory);
    if(canonical!==directory) throw new Error('Fixture temp path is not canonical');
    const result=await syncDirectory(directory);
    console.log(JSON.stringify({canonical:true,isolated:true,version:helperPackage.version,synchronization:result}));`;
  receipt.publishedTempPreflight = jsonOutput((await run(process.execPath,
    ["--input-type=module", "-e", durabilityCode], "published-temp-durability")).stdout);

  await cli(["gateway", "install", "--force", "--port", String(port), "--json"], "published-install", { timeout: 300000 });
  const before = await healthy("published-health");
  taskBefore = await task();
  assert(taskBefore.settings && taskBefore.triggers, "Missing native XML settings/triggers");
  assert.equal(taskBefore.logon, 3, "Expected InteractiveToken");
  assert.equal(taskBefore.level, 0, "Expected least privilege");
  assert.equal(taskBefore.enabled, true);
  let requestSequence = 0;
  server = http.createServer((req, res) => {
    const id = ++requestSequence;
    const began = Date.now();
    const candidate = req.url === "/candidate.tgz";
    diagnostic({ kind: "http-start", id, candidate,
      method: enumValue(req.method, ["GET", "HEAD"]) });
    if (!candidate) { res.writeHead(404); res.end(); return; }
    let bytes = 0;
    const stream = createReadStream(packageFile);
    stream.on("data", chunk => { bytes += chunk.length; });
    stream.on("error", () => { diagnostic({ kind: "http-stream-error", id }); res.destroy(); });
    res.on("finish", () => diagnostic({ kind: "http-finish", id, bytes, elapsedMs: Date.now() - began }));
    res.on("close", () => { diagnostic({ kind: "http-close", id, bytes, finished: res.writableFinished }); stream.destroy(); });
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    stream.pipe(res);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = "http://127.0.0.1:" + server.address().port + "/candidate.tgz";
  // This call begins in the unmodified installed, published driver; no pre-stop.
  await verifyPublishedRuntime();
  let sampling = Promise.resolve(), samplingBusy = false;
  const observe = () => {
    if (samplingBusy) return;
    samplingBusy = true;
    sampling = sampleUpdateLedger().finally(() => { samplingBusy = false; });
  };
  observe();
  const progressTimer = setInterval(observe, 15000);
  let update;
  try {
    update = await cli(["update", "--tag", url, "--yes", "--json", "--timeout", "1200"],
      "published-update", { timeout: 1800000, check: false });
  } finally {
    clearInterval(progressTimer);
    await sampling;
    await sampleUpdateLedger(); // Retain last observation before exact-state teardown.
  }
  assert.equal(update.code, 0, "Published updater rejected candidate");
  const updateJson = jsonOutput(update.stdout);
  assert.equal(updateJson.status, "ok", "Published updater did not report success");
  const buildInfo = JSON.parse(await fs.readFile(path.join(prefix, "node_modules", "openclaw", "dist", "build-info.json"), "utf8"));
  assert.equal(buildInfo.commit, candidateSha, "Installed candidate source differs");
  const after = await healthy("candidate-health", before.pid);
  after.buildId = await candidateBuildEvidence("candidate-build-probe", buildInfo.buildId);
  const afterTask = await task();
  assert.deepEqual(settings(afterTask), settings(taskBefore), "Update changed existing operator task settings");
  receipt.cells.push({ name: "published-driver-existing-service-update", status: "PASS", before, after,
    preservedTaskSettings: true, installedSource: buildInfo.commit });

  // Separate operator recovery, not a claim of published-updater rollback.
  await cli(["gateway", "stop", "--json"], "candidate-stop");
  assert.equal(await bindable(port), true, "Port retained after candidate stop");
  scriptPath = path.join(stateDir, "gateway.cmd");
  savedScript = await fs.readFile(scriptPath);
  await fs.writeFile(scriptPath, Buffer.concat([Buffer.from("@echo off\r\nexit /b 23\r\n"), savedScript]));
  const rejected = await cli(["gateway", "start", "--json"], "rejected-start", { timeout: 120000, check: false });
  assert.notEqual(rejected.code, 0, "Failed native action reported as successful");
  assert.match(rejected.output, /refusing a direct fallback/i, "Wrong rejection contract");
  assert.equal(await bindable(port), true, "Rejected activation left a listener");
  assert.equal((await task()).exists, true, "Rejection removed recoverable task registration");
  await fs.writeFile(scriptPath, savedScript); savedScript = undefined;
  await cli(["gateway", "start", "--json"], "recovery-start", { timeout: 120000 });
  const recovered = await healthy("recovery-health", after.pid);
  recovered.buildId = await candidateBuildEvidence("recovery-build-probe", buildInfo.buildId);
  assert.deepEqual(settings(await task()), settings(taskBefore), "Recovery changed task settings");
  receipt.cells.push({ name: "installed-candidate-rejected-activation-recovery", status: "PASS", recovered });
  receipt.status = "PASS";
} catch (error) {
  receipt.error = redact(error.stack ?? error);
} finally {
  const errors = [];
  if (server) await new Promise(r => server.close(r));
  if (savedScript && scriptPath) await fs.writeFile(scriptPath, savedScript).catch(e => errors.push(redact(e.message)));
  try {
    assert(taskAdmitted, "Task ownership was not admitted; preserving unknown task");
    const t = await task();
    if (t.exists) {
      await run("schtasks.exe", ["/End", "/TN", taskName], "cleanup-end", { check: false });
      await run("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], "cleanup-delete");
    }
    const cleanupOwners = new Map(observedOwners);
    for (const owner of await ownedProcesses()) cleanupOwners.set(owner.pid + ":" + owner.created, owner);
    for (const owner of cleanupOwners.values()) {
      await ps([
        "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + owner.pid + "'",
        "if ($p) { if ($p.CreationDate.ToUniversalTime().ToString('o') -cne " + psQuote(owner.created) + ") { throw 'PID incarnation changed during cleanup' }",
        "Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop }"
      ].join("\n"), "cleanup-process");
    }
    for (let i = 0; i < 30 && (!(await bindable(port)) || (await ownedProcesses()).length); i++) await sleep(500);
    for (const owner of cleanupOwners.values()) {
      await ps([
        "$p=Get-CimInstance Win32_Process -Filter 'ProcessId=" + owner.pid + "'",
        "if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq " + psQuote(owner.created) + ") { throw 'Captured task action process remains after cleanup' }"
      ].join("\n"), "verify-captured-action-absence");
    }
    receipt.cleanup.capturedActionHostsAbsent = true;
    receipt.cleanup.taskAbsent = !(await task()).exists;
    receipt.cleanup.processesAbsent = (await ownedProcesses()).length === 0;
    receipt.cleanup.portReusable = await bindable(port);
    assert(receipt.cleanup.taskAbsent && receipt.cleanup.processesAbsent && receipt.cleanup.portReusable, "Native resources remain");
    if (stateOwned) await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    receipt.cleanup.stateRemoved = true;
  } catch (error) { errors.push(redact(error.stack ?? error)); }
  receipt.cleanup.errors = errors;
  if (errors.length) receipt.status = "FAIL";
  await fs.writeFile(path.join(proofDir, "proof.json"), JSON.stringify(receipt, null, 2) + "\n");
}
console.log(JSON.stringify({ status: receipt.status, cells: receipt.cells, cleanup: receipt.cleanup }));
if (receipt.status !== "PASS") process.exitCode = 1;
