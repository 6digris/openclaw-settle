import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { threadId, isMainThread } from 'node:worker_threads';
import { instrument } from './pr148066-instrument.mjs';
const output = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../.pr148066-capture-location.json'), 'utf8')).output;
const hash = b => createHash('sha256').update(b).digest('hex');
const limit = s => String(s ?? '').slice(0, 65536);
const allow = new Set(['SYSTEMROOT','WINDIR','SYSTEMDRIVE','HOME','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','PROGRAMDATA','ALLUSERSPROFILE','TEMP','TMP','TMPDIR','PSMODULEANALYSISCACHEPATH','PSMODULEPATH','PATH','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)','COMMONPROGRAMW6432','NODE_OPTIONS','RAYON_NUM_THREADS','TOKIO_WORKER_THREADS']);
let cell, rawSpawn, lastExe, lastEnv;
const receipt = { cells: [], scope: 'prospective Vitest worker; not historical reconstruction', excluded: 'registration/found/delete not executed or counted passing', historicalRootEstablished: false };
function save() { fs.writeFileSync(path.join(output,'worker.json'), JSON.stringify(receipt,null,2)+'\n'); }
function event(value) { fs.appendFileSync(path.join(output,'worker-events.jsonl'),JSON.stringify({...value,at:new Date().toISOString(),monotonicMs:performance.now()})+'\n'); }
function selected(env) { return Object.fromEntries(Object.entries(env).filter(([k])=>allow.has(k.toUpperCase())).map(([k,v])=>[k,limit(v)])); }
function meta(p) { try { const s=fs.statSync(p);return {path:p,size:s.size,mtimeMs:s.mtimeMs,directory:s.isDirectory()}; } catch(e){return {path:p,error:e.code};} }
function cache(env) {
  const get=k=>Object.entries(env).find(([key])=>key.toUpperCase()===k)?.[1];
  // Metadata only: do not list modules, read executable/cache contents, or start PowerShell.
  return [get('PSMODULEANALYSISCACHEPATH'),get('LOCALAPPDATA')&&path.join(get('LOCALAPPDATA'),'Microsoft','Windows','PowerShell'),get('USERPROFILE')&&path.join(get('USERPROFILE'),'AppData','Local','Microsoft','Windows','PowerShell')].filter(Boolean).map(meta);
}
function resources() { return {pid:process.pid,threadId,isMainThread,argv:process.argv,execArgv:process.execArgv,nodeVersion:process.version,nodeExecutable:process.execPath,cwd:process.cwd(),uptimeSec:process.uptime(),memory:process.memoryUsage(),usage:process.resourceUsage(),threadCpu:process.threadCpuUsage?.(),freeMemory:os.freemem(),totalMemory:os.totalmem(),availableParallelism:os.availableParallelism(),fixtureHome:process.env.HOME,tmp:os.tmpdir(),selectedEnvironment:selected(process.env)}; }
export function begin(label,taskName) { assert(['baseline-first-use','instrumented-after-baseline'].includes(label));cell={label,taskName};receipt.cells.push(cell); }
export function observe(spawn,exe,args,options) {
  assert(cell); assert.equal(path.win32.basename(exe).toLowerCase(),'powershell.exe');
  assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);
  assert.equal(args.length,4);assert.equal(options.timeout,5000);assert.equal(options.windowsHide,false);assert.equal(options.encoding,'utf8');
  rawSpawn=spawn;lastExe=exe;lastEnv=options.env;
  const original=Buffer.from(args[3],'base64').toString('utf16le');
  assert(!/RegisterTask|schtasks|\/Create|Start-ScheduledTask/i.test(original));
  const instrumented=cell.label==='instrumented-after-baseline';
  const actualArgs=instrumented?[...args.slice(0,3),Buffer.from(instrument(original),'utf16le').toString('base64')]:args;
  const observationStart=performance.now();
  Object.assign(cell,{before:resources(),cacheBefore:cache(options.env),exe,args:actualArgs,originalScriptSha256:hash(original),scriptSha256:hash(Buffer.from(actualArgs[3],'base64')),managerEnvironment:selected(options.env),managerEnvironmentKeys:Object.keys(options.env).sort(),options:{timeout:options.timeout,windowsHide:options.windowsHide,encoding:options.encoding},instrumented});
  event({event:'outer-child-start',label:cell.label});save();
  cell.beforeObservationOverheadMs=performance.now()-observationStart;
  const started=performance.now();cell.started=new Date().toISOString();
  // Baseline forwards exact original executable, argument array and options object.
  const r=spawn(exe,actualArgs,options);
  cell.elapsedMs=performance.now()-started;cell.ended=new Date().toISOString();
  const afterStart=performance.now();
  Object.assign(cell,{pid:r.pid,status:r.status,signal:r.signal,error:r.error?{code:r.error.code,errno:r.error.errno,syscall:r.error.syscall}:null,stdout:limit(r.stdout),stderr:limit(r.stderr),stdoutChars:String(r.stdout??'').length,stderrChars:String(r.stderr??'').length,after:resources(),cacheAfter:cache(options.env)});
  event({event:'outer-child-end',label:cell.label,pid:r.pid,status:r.status,signal:r.signal,error:r.error?.code??null});
  cell.afterObservationOverheadMs=performance.now()-afterStart;save();
  return r;
}
export function finish(classification) { cell.classification=classification; if(cell.label==='baseline-first-use') receipt.disposition=classification.status==='missing'?'NON_REPRODUCTION':classification.timeoutMs===5000?'BASELINE_TIMEOUT_CAPTURED':'BASELINE_OTHER_FAILURE';save(); }
export function postBaselineIdentity() {
  if(!rawSpawn)return;
  // Explicitly after both cells: these reads/queries may warm image caches.
  const script="$ErrorActionPreference='Stop'; $id=[Security.Principal.WindowsIdentity]::GetCurrent(); [ordered]@{ version=$PSVersionTable.PSVersion.ToString(); executable=(Get-Process -Id $PID).Path; account=$id.Name; sid=$id.User.Value; sessionId=(Get-Process -Id $PID).SessionId; pid=$PID } | ConvertTo-Json -Compress";
  const start=performance.now();const r=rawSpawn(lastExe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:lastEnv,encoding:'utf8',timeout:5000,windowsHide:false});
  receipt.postBaselineIdentity={pid:r.pid,status:r.status,signal:r.signal,error:r.error?.code??null,stdout:limit(r.stdout),stderr:limit(r.stderr),elapsedMs:performance.now()-start};save();
  receipt.postBaselineBinaries=[process.execPath,lastExe].map(p=>({realpath:fs.realpathSync(p),sha256:hash(fs.readFileSync(p))}));
  receipt.complete=true;save();
}
