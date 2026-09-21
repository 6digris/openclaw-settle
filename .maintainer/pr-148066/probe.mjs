import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { root, manifest, sha256, exactInitializer, instrument } from './loader.mjs';
const selfCheck = process.argv[2] === '--self-check';
const [proof, order] = process.argv.slice(2);
const rawSpawn = cp.spawnSync;
const rawExec = cp.execFileSync;
const records = [];
let current = null;
let lastExe;
let lastBaseline;
function result(r) {
  return { pid: r.pid ?? null, status: r.status, signal: r.signal, error: r.error ? { code: r.error.code, errno: r.error.errno, syscall: r.error.syscall } : null,
    stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}
function save(name, value) { if (!selfCheck) fs.writeFileSync(path.join(proof, name), JSON.stringify(value, null, 2) + '\n'); }
cp.execFileSync = (exe, args, options) => {
  assert.equal(path.basename(exe).toLowerCase(), 'reg.exe');
  assert.equal(args[0], 'query');
  const started = new Date().toISOString(), start = performance.now();
  try {
    const value = rawExec(exe, args, options);
    records.push({ kind: 'registry-query', exe, args, started, ended: new Date().toISOString(), elapsedMs: performance.now()-start, stdout: String(value) });
    return value;
  } catch (e) {
    records.push({ kind: 'registry-query', exe, args, started, ended: new Date().toISOString(), elapsedMs: performance.now()-start, code: e.code, status: e.status, signal: e.signal });
    throw e;
  }
};
cp.spawnSync = (exe, args, options) => {
  assert.equal(path.win32.basename(exe).toLowerCase(), 'powershell.exe');
  assert.deepEqual(args.slice(0,3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(options.timeout, 5000); assert.equal(options.windowsHide, false); assert.equal(options.encoding, 'utf8');
  assert(current);
  const original = Buffer.from(args[3], 'base64').toString('utf16le');
  assert(!/RegisterTask|schtasks|\/Create|Start-ScheduledTask/i.test(original));
  const actual = current.instrumented ? instrument(original) : original;
  const actualArgs = [...args.slice(0,3), Buffer.from(actual, 'utf16le').toString('base64')];
  if (!selfCheck) fs.writeFileSync(path.join(proof, `script-${sha256(actual)}.ps1`), actual);
  const started = new Date().toISOString(), start = performance.now();
  if (!selfCheck) fs.appendFileSync(path.join(proof, 'child-events.jsonl'), JSON.stringify({ event: 'powershell-begin', label: current.label, started })+'\n');
  const r = selfCheck ? { pid: null, status: 1, signal: null, stdout: '-2147024894\r\n', stderr: '' } : rawSpawn(exe, actualArgs, options);
  const ended = new Date().toISOString(), elapsedMs = performance.now()-start;
  let pidGone = null;
  if (r.pid) { try { process.kill(r.pid, 0); pidGone = false; } catch (e) { pidGone = e.code === 'ESRCH' ? true : null; } }
  const record = { kind: 'powershell-probe', ...current, exe, args: actualArgs, originalScriptSha256: sha256(original), executedScriptSha256: sha256(actual),
    started, ended, elapsedMs, timeoutMs: options.timeout, windowsHide: options.windowsHide, env: envObservation(options.env), ...result(r), pidGone };
  records.push(record);
  if (!selfCheck) fs.appendFileSync(path.join(proof, 'child-events.jsonl'), JSON.stringify({ event: 'powershell-end', label: current.label, ended, elapsedMs, status: r.status, signal: r.signal, error: r.error?.code ?? null })+'\n');
  lastExe = exe;
  return r;
};
syncBuiltinESMExports();
const { resolveServiceManagerEnv } = await import('./source-exact/src/daemon/service-process-env.ts');
const { resolveEnvironmentValue } = await import('./source-exact/src/infra/process-env.ts');
const { resolveTestCorepackHome } = await import('./source-exact/test/test-home-context.mts');
const { setTestEnvValue, deleteTestEnvValue } = await import('./source-exact/src/test-utils/env.ts');
const { probeScheduledTaskState } = await import('./source-exact/src/daemon/schtasks-state-probe.ts');
const delta = ['SYSTEMDRIVE','ALLUSERSPROFILE','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMMONPROGRAMW6432','PSMODULEANALYSISCACHEPATH'];
const routing = new Set(['SYSTEMROOT','WINDIR','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA','TMPDIR','TEMP','TMP','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR', ...delta]);
function envObservation(env) {
  return Object.fromEntries(Object.entries(env).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k, { present: true, sha256: sha256(v), ...(routing.has(k.toUpperCase()) ? { route: v } : {}) }]));
}
function cacheObservation() {
  const local = resolveEnvironmentValue(process.env, 'LOCALAPPDATA');
  const profile = resolveEnvironmentValue(process.env, 'USERPROFILE');
  const explicit = resolveEnvironmentValue(process.env, 'PSModuleAnalysisCachePath');
  const paths = [explicit, local && path.join(local,'Microsoft','Windows','PowerShell'), profile && path.join(profile,'AppData','Local','Microsoft','Windows','PowerShell')].filter(Boolean);
  return paths.map(p => {
    try {
      const stat = fs.statSync(p); const entries = stat.isDirectory() ? fs.readdirSync(p).sort() : [];
      return { path:p, isDirectory:stat.isDirectory(), size:stat.size, mtimeMs:stat.mtimeMs, entryCount:entries.length, entries:entries.slice(0,32).map(name=>{
        const s=fs.statSync(path.join(p,name));return {name,size:s.size,mtimeMs:s.mtimeMs,isDirectory:s.isDirectory()};
      }), truncated:entries.length>32 };
    } catch (e) { return {path:p,error:e.code}; }
  });
}
if (selfCheck) {
  current = { label: 'non-native-source-self-check', instrumented: false };
  assert.deepEqual(probeScheduledTaskState('OpenClaw probe test ' + randomUUID()), {status:'missing'});
  current = { label: 'non-native-instrumentation-self-check', instrumented: true };
  assert.deepEqual(probeScheduledTaskState('OpenClaw probe test ' + randomUUID()), {status:'missing'});
  assert.equal(records.filter(x=>x.kind==='powershell-probe').length, 2);
  const fake = { platform:'win32', env:{LOCALAPPDATA:'C:\\Users\\runneradmin\\AppData\\Local',SystemDrive:'C:'} };
  exactInitializer({process:fake,path:path.win32,setTestEnvValue:(k,v)=>{fake.env[k]=v;},deleteTestEnvValue:k=>{delete fake.env[k];},resolveTestCorepackHome:()=> 'C:\\corepack'})('C:\\fixture');
  assert.equal(fake.env.USERPROFILE,'C:\\fixture'); assert.equal(fake.env.HOME,'C:\\fixture');
  assert.equal(fake.env.XDG_RUNTIME_DIR,'C:\\fixture\\.runtime'); assert.equal(fake.env.SystemDrive,'C:');
  console.log('Pinned source import, baseline options, classification and instrumentation transformation verified; no native proof.');
} else {
  assert.equal(process.platform, 'win32'); assert.equal(process.version, 'v24.20.0'); assert(['forward','reverse'].includes(order));
  const taskName = 'OpenClaw probe test ' + randomUUID();
  const nativeHome = process.env.USERPROFILE;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-test-home-'));
  exactInitializer({process,path,setTestEnvValue,deleteTestEnvValue,resolveTestCorepackHome})(tempHome);
  lastBaseline = resolveServiceManagerEnv();
  const receipt = { original:manifest, taskName, nativeHome, tempHome, order, node:{realpath:fs.realpathSync(process.execPath),version:process.version,arch:process.arch,abi:process.versions.modules},
    environment:envObservation(lastBaseline), deltaKeys:delta.map(key=>({key,present:resolveEnvironmentValue(lastBaseline,key)!==undefined})),
    limitations:['Fresh runner, not the original failed machine/image state; historical fixture random suffix was not retained.',
      'Original source and home/manager-env selection; standalone Node is not the original Vitest worker/concurrency envelope.',
      'No PowerShell 5.1 prewarm by this harness; checkout/image prior activity is unknown.',
      'Only baseline is first. Instrumented and reverse-order comparisons share warmed/cache/order state; no cold-equivalence claim.',
      'Seven-key omission is a historical119052 comparator, not a claim those keys were absent in148066.',
      'Absent phase markers never uniquely localize startup; passing later probes never clear historical failure.'], records };
  const schedule = order === 'forward' ? [ ['baseline-first',false,false],['baseline-instrumented',false,true],['omit-seven',true,false],['omit-seven-instrumented',true,true],['baseline-last',false,false] ] :
    [ ['baseline-first',false,false],['omit-seven-instrumented',true,true],['omit-seven',true,false],['baseline-instrumented',false,true],['baseline-last',false,false] ];
  try {
    for (const [label,omit,instrumented] of schedule) {
      for (const key of delta) {
        for (const actual of Object.keys(process.env)) if (actual.toUpperCase()===key) delete process.env[actual];
        if (!omit) for (const [actual,value] of Object.entries(lastBaseline)) if (actual.toUpperCase()===key) process.env[actual]=value;
      }
      current = { label, instrumented, variant:omit?'omit-seven':'baseline', cacheBefore:cacheObservation() };
      const classification = probeScheduledTaskState(taskName);
      const rec=records.at(-1);rec.classification=classification;rec.cacheAfter=cacheObservation();
      rec.originalAssertionSatisfied = classification.status==='missing';
      save('probe-results.json',receipt);
    }
    receipt.node.sha256=sha256(fs.readFileSync(process.execPath));
    const identityScript = "$ErrorActionPreference='Stop'; $id=[Security.Principal.WindowsIdentity]::GetCurrent(); [ordered]@{ version=$PSVersionTable.PSVersion.ToString(); edition=$PSVersionTable.PSEdition; executable=(Get-Process -Id $PID).Path; account=$id.Name; sid=$id.User.Value; sessionId=(Get-Process -Id $PID).SessionId; interactive=[Environment]::UserInteractive; pid=$PID } | ConvertTo-Json -Compress";
    const start=performance.now();
    const id=rawSpawn(lastExe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(identityScript,'utf16le').toString('base64')],{env:lastBaseline,encoding:'utf8',windowsHide:false,timeout:5000});
    let identityPidGone=null; if(id.pid){try{process.kill(id.pid,0);identityPidGone=false;}catch(e){identityPidGone=e.code==='ESRCH'?true:null;}}
    receipt.postProbeIdentity={...result(id),pidGone:identityPidGone,elapsedMs:performance.now()-start,realpath:fs.realpathSync(lastExe),sha256:sha256(fs.readFileSync(lastExe))};
    if (!id.error && id.status===0) {
      receipt.postProbeIdentity.parsed=JSON.parse(id.stdout);
      assert(receipt.postProbeIdentity.parsed.version.startsWith('5.1.'));
    }
    receipt.historicalRootEstablished=false;
    receipt.baselineAssertionSatisfied=records.filter(r=>r.kind==='powershell-probe'&&r.variant==='baseline').every(r=>r.originalAssertionSatisfied);
    receipt.instrumentationComplete=records.filter(r=>r.kind==='powershell-probe'&&r.instrumented).every(r=>r.stderr.includes('PR148066:entry:')&&r.stderr.includes('PR148066:caught-hresult:'));
    receipt.complete=true;
    // Retain the original missing assertion as a real failed outcome while still collecting all diagnostics.
    if (!receipt.baselineAssertionSatisfied || !receipt.instrumentationComplete || id.error || id.status!==0) process.exitCode=1;
  } finally { save('probe-results.json',receipt); }
}
