import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const proof=import.meta.dirname, source=path.resolve(proof,'../../../source');
const output=path.join(process.env.RUNNER_TEMP,'pr148066-vitest');
const hash=b=>createHash('sha256').update(b).digest('hex');
const write=(name,value)=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n');
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.20.0');
assert(['prepare','run','cleanup'].includes(process.argv[2]));
const bindings=JSON.parse(fs.readFileSync(path.join(proof,'vitest-source-bindings.json'),'utf8'));
const all=[...bindings.originalSix,...bindings.additionalRunnerInputs];
const events=[];const pids=[];
function capacity(stage,estimatedGrowthBytes) {
 const stats=fs.statfsSync(source);const free=stats.bavail*stats.bsize;
 const receipt={stage,source,freeBytes:free,estimatedGrowthBytes,otherKnownGrowthBytes:0,freshHostedVM:true,at:new Date().toISOString()};write('capacity-'+stage+'.json',receipt);assert(free>estimatedGrowthBytes,'actual capacity insufficient');
}
if(process.argv[2]==='prepare') {
 fs.mkdirSync(output,{recursive:false}); capacity('before-dependencies',12*1024**3);
 const verified=all.map(b=>{const actual=hash(fs.readFileSync(path.join(source,b.path)));assert.equal(actual,b.sha256,b.path);return {...b,actual};});write('source-verified.json',{source:bindings.historicalSource,files:verified});
 const original=fs.readFileSync(path.join(source,'src/daemon/schtasks-state-probe.windows.test.ts'),'utf8');
 const derived=fs.readFileSync(path.join(proof,'missing-only.test.ts'),'utf8');
 const prefix=original.slice(original.indexOf('    const taskName ='),original.indexOf('    const created ='));
 const stripped=derived.replace('    observedTask = taskName;\n    begin("baseline-first-use", taskName);\n','').replace('    finish(missing);\n','');
 assert(stripped.includes(prefix.trimEnd()));assert(!/\/Create|\/Delete|spawnSync\("schtasks/.test(derived));
 fs.copyFileSync(path.join(proof,'missing-only.test.ts'),path.join(source,'src/daemon/schtasks-state-probe.windows.test.ts'));
 fs.copyFileSync(path.join(proof,'capture.mjs'),path.join(source,'src/daemon/pr148066-capture.mjs'));
 fs.copyFileSync(path.join(proof,'instrument.mjs'),path.join(source,'src/daemon/pr148066-instrument.mjs'));
 fs.writeFileSync(path.join(source,'.pr148066-capture-location.json'),JSON.stringify({output}));
 write('derivation.json',{originalFixtureSha256:hash(original),derivedFixtureSha256:hash(derived),originalMissingPrefixPreserved:true,registrationFoundDelete:'OUT_OF_SCOPE_PHYSICALLY_ABSENT',changes:['derived fixture','pr148066-capture.mjs','pr148066-instrument.mjs','.pr148066-capture-location.json'],limitations:['New baseline observation, never historical reconstruction','fresh windows-2025 image, cache, binary and UUID/home randomness','Defender unchanged, unlike historical exclusions','setup action cache-mode off; dependency/image state not historical','Selected read-only fixture via original router instead of executing full Windows suite','Same runtime-build command explicitly immediately before selected router because selected fixture alone does not request a build','Extra Vitest mock-forwarder and metadata I/O overhead recorded; baseline native args/options unchanged','Instrumented cell follows baseline in same worker/home and shares warm/order state; no COM-vs-discovery inference','No prewarm or native identity/content hash before baseline; earlier runner/bootstrap PowerShell activity is not known cold state']});
} else if(process.argv[2]==='run') {
 capacity('before-build',4*1024**3);
 const env={...process.env,NODE_OPTIONS:'--max-old-space-size=8192',OPENCLAW_VITEST_MAX_WORKERS:'1',OPENCLAW_TEST_PROJECTS_PARALLEL:'1',OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD:'1'};
 const initial={at:new Date().toISOString(),node:process.version,argv:process.argv,pid:process.pid,source,proofHead:process.env.GITHUB_SHA,imageOS:process.env.ImageOS,imageVersion:process.env.ImageVersion,runnerOS:process.env.RUNNER_OS,totalMemory:os.totalmem(),freeMemory:os.freemem(),cpus:os.availableParallelism(),fixedEnv:{NODE_OPTIONS:env.NODE_OPTIONS,OPENCLAW_VITEST_MAX_WORKERS:'1',OPENCLAW_TEST_PROJECTS_PARALLEL:'1',OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD:'1'}};write('run.json',initial);
 async function command(label,args,timeout) {
  const start=performance.now();let bytes=0,overflow=false;const log=fs.openSync(path.join(output,label+'.log'),'w');
  const child=spawn(process.execPath,args,{cwd:source,env,stdio:['ignore','pipe','pipe']});pids.push(child.pid);events.push({event:'start',label,pid:child.pid,args,at:new Date().toISOString()});write('processes.json',{pids,events});
  const timer=setTimeout(()=>{child.kill();},timeout);
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes<=8*1024**2){fs.writeSync(log,b);process.stdout.write(b);}else if(!overflow){overflow=true;child.kill();}});
  const result=await new Promise(resolve=>{child.on('error',e=>resolve({error:e.code}));child.on('close',(status,signal)=>resolve({status,signal}));});clearTimeout(timer);fs.closeSync(log);events.push({event:'end',label,...result,overflow,bytes,elapsedMs:performance.now()-start,at:new Date().toISOString()});write('processes.json',{pids,events});return {...result,overflow};
 }
 let result;
 try {
  const build=await command('runtime-build',['scripts/run-node.mjs','--version'],15*60*1000);assert.equal(build.status,0,'runtime build failed');assert(!build.overflow);
  result=await command('vitest',['--import','./scripts/tsx.mjs','scripts/test-projects.mts','src/daemon/schtasks-state-probe.windows.test.ts'],3*60*1000);
  const worker=JSON.parse(fs.readFileSync(path.join(output,'worker.json'),'utf8'));
  write('outcome.json',{disposition:worker.disposition,vitest:result,baseline:worker.cells[0]?.classification,historicalRootEstablished:false,productPatch:false,oneRunConsumed:true});
  if(result.status!==0||result.overflow||!worker.complete)process.exitCode=1;
 } catch(e) {write('driver-error.json',{message:e.message});process.exitCode=1;}
 finally {
  cleanupSource();
 }
}

function cleanupSource() {
  if(!fs.existsSync(output))fs.mkdirSync(output,{recursive:true});
  if(!fs.existsSync(source)){write('cleanup-readback.json',{source,absent:true});return;}
  const proc=path.join(output,'processes.json');if(fs.existsSync(proc))pids.push(...JSON.parse(fs.readFileSync(proc,'utf8')).pids);
  // Identity/process inventory is deliberately after the baseline (or setup failure).
  const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const q=spawnSync(ps,['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],{encoding:'utf8',timeout:10000,windowsHide:false});
  let cleanup={source,removed:false,postflightStatus:q.status,postflightError:q.error?.code??null};
  try {
   assert.equal(q.status,0);const inventory=JSON.parse(q.stdout);const owned=new Set(pids.filter(Boolean));
   const workerPath=path.join(output,'worker.json');const worker=fs.existsSync(workerPath)?JSON.parse(fs.readFileSync(workerPath,'utf8')):null;
   for(const cell of worker?.cells??[]){if(cell.pid)owned.add(cell.pid);if(cell.before?.pid)owned.add(cell.before.pid);}if(worker?.postBaselineIdentity?.pid)owned.add(worker.postBaselineIdentity.pid);
   let changed=true;while(changed){changed=false;for(const p of inventory)if(owned.has(p.ParentProcessId)&&!owned.has(p.ProcessId)){owned.add(p.ProcessId);changed=true;}}
   const live=inventory.filter(p=>owned.has(p.ProcessId)||(p.CommandLine && p.CommandLine.toLowerCase().includes(source.toLowerCase())));cleanup.liveOwnedProcesses=live.map(({ProcessId,ParentProcessId,Name})=>({ProcessId,ParentProcessId,Name}));assert.equal(live.length,0,'owned child processes remain; do not erase paths');
   const home=worker?.cells?.[0]?.before?.fixtureHome;const temp=worker?.cells?.[0]?.before?.tmp;
   cleanup.namespaces=[];
   if(home){let dir=home;while(path.dirname(dir)!==dir&&!/^oc-vt-[A-Za-z0-9]+$/.test(path.basename(dir)))dir=path.dirname(dir);assert(/^oc-vt-[A-Za-z0-9]+$/.test(path.basename(dir)),'unexpected namespace');assert(home.startsWith(dir+path.sep));fs.rmSync(dir,{recursive:true,force:true});cleanup.namespaces.push({path:dir,absent:!fs.existsSync(dir),fixture:home,temp});}
   // Entire task-private historical checkout is recoverable from exact source + reviewed derivative.
   assert.equal(path.basename(source),'source');fs.rmSync(source,{recursive:true,force:true,maxRetries:3,retryDelay:500});cleanup.removed=!fs.existsSync(source);
  }catch(e){cleanup.error=e.message;process.exitCode=1;}
  write('cleanup.json',cleanup);
}
if(process.argv[2]==='cleanup')cleanupSource();
