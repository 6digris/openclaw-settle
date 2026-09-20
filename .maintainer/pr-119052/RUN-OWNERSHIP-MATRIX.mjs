// Task-private real-Windows proof. Lease mutations are explicit adversarial
// fixture inputs; native process inspection, taskkill, tasklist and time are real.
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, root, head, selectedCellIds] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
assert.match(head, /^[a-f0-9]{40}$/);
const nativeSpawnSync = cp.spawnSync;
assert.equal(nativeSpawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {encoding:'utf8'}).stdout.trim(), head);
await fs.mkdir(root);
const load = p => import(pathToFileURL(path.join(repo,p)).href);
const { terminateScheduledTaskGatewayListeners, probeProcessState } = await load('src/daemon/schtasks-process.ts');
const { buildTaskScript, resolveTaskScriptPath } = await load('src/daemon/schtasks-layout.ts');
const { encodeWindowsLauncherScript } = await load('src/infra/windows-launcher-encoding.ts');
const { readWindowsProcessStartTimeSync } = await load('src/infra/windows-process-start.ts');
const { acquireGatewayLifecycleCoordinator } = await load('src/infra/state-database-coordinator.ts');
const { resolveOpenClawStateSqlitePath } = await load('src/state/openclaw-state-db.paths.ts');
const { withOpenClawStateStartupMigrationCheckpointDatabase } = await load('src/state/openclaw-state-db.ts');
const { closeOpenClawStateDatabaseByPathAsync } = await load('src/state/openclaw-state-db-cache.ts');
const { acquireOpenClawStateLeaseInTransaction, releaseOpenClawStateLeaseInTransaction } = await load('src/state/openclaw-state-lease-store.ts');
const { runSqliteImmediateTransactionSync } = await load('src/infra/sqlite-transaction.ts');
const { readGatewayOwnerLease } = await load('src/infra/gateway-owner-lease.ts');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const cases=['stale-incarnation','valid-owner-force','released-same-incarnation','same-owner-changed-incarnation','same-owner-changed-supervisor','same-owner-replaced-pid','owner-token-replacement','degraded-cim-tasklist'];
const selectedIds=selectedCellIds?selectedCellIds.split(','):cases;
assert.ok(selectedIds.length>0 && new Set(selectedIds).size===selectedIds.length);
assert.ok(selectedIds.every(id=>cases.includes(id)),'Unknown selected ownership cell');
const summary={head,driverSha256:createHash('sha256').update(await fs.readFile(new URL(import.meta.url))).digest('hex'),platform:process.platform,status:'RUNNING',cells:selectedIds.map(id=>({id,status:'UNRUN'})),limitations:['Stale PID incarnation is a deliberately stale real SQLite lease bound to a live Windows PID; OS PID reuse is not forced.','No Scheduler action is registered by this ownership driver; maintained lifecycle proof covers that path.','Forced taskkill is observed natively with the production 15-second wait bound; an OS termination delay beyond five seconds is not synthesized.','Degraded CIM is one real PowerShell command forced to throw; tasklist output and all taskkill execution remain native.']};
const save=()=>fs.writeFile(path.join(root,'ownership.json'),JSON.stringify(summary,null,2)+'\n');
await save();
for(const row of summary.cells){
  const cellRoot=path.join(root,row.id); await fs.mkdir(cellRoot);
  const env={...process.env,OPENCLAW_HOME:undefined,OPENCLAW_PROFILE:'pr119052-owner-'+randomUUID().slice(0,8),OPENCLAW_STATE_DIR:path.join(cellRoot,'state'),OPENCLAW_CONFIG_PATH:path.join(cellRoot,'state','openclaw.json'),OPENCLAW_WINDOWS_TASK_NAME:'OpenClaw-119052-owner-'+randomUUID(),OPENCLAW_GATEWAY_PORT:'19483',OPENCLAW_SERVICE_KIND:'gateway'};
  await fs.mkdir(env.OPENCLAW_STATE_DIR);
  const actor=path.join(cellRoot,'index.mjs');
  await fs.writeFile(actor,"setInterval(()=>{},1000);setTimeout(()=>process.exit(0),180000);\n");
  const argv=[process.execPath,actor,'gateway','--port','19483'];
  const script=resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(script),{recursive:true});
  await fs.writeFile(script,encodeWindowsLauncherScript({format:'cmd',content:buildTaskScript({programArguments:argv})}));
  const identities=[]; let coordinator, databasePath;
  const identity={scope:'gateway-owner',key:'global',owner:'fixture-'+randomUUID()};
  let currentLeaseIdentity=identity;
  const commands=[]; let child, replacement, forcedAt, degradedCalls=0;
  const recordChild=async()=>{
    const processChild=cp.spawn(process.execPath,argv.slice(1),{env,stdio:'ignore',windowsHide:true});
    const record={child:processChild,pid:processChild.pid,startedAt:null,spawnError:null};
    identities.push(record);
    await new Promise((resolve,reject)=>{processChild.once('spawn',resolve);processChild.once('error',error=>{record.spawnError=error;reject(error);});});
    assert.ok(record.pid>1);
    const deadline=Date.now()+15000; let born;
    while(Date.now()<deadline && born==null){born=readWindowsProcessStartTimeSync(processChild.pid,5000,env);if(born==null)await sleep(100)}
    assert.ok(Number.isSafeInteger(born));
    record.startedAt=born;return record;
  };
  function changeLease(record,supervisor=env.OPENCLAW_WINDOWS_TASK_NAME,owner=identity.owner){
    withOpenClawStateStartupMigrationCheckpointDatabase(db=>runSqliteImmediateTransactionSync(db,()=>{
      releaseOpenClawStateLeaseInTransaction(db,currentLeaseIdentity);
      currentLeaseIdentity={...identity,owner};
      if(record){assert.ok(acquireOpenClawStateLeaseInTransaction(db,currentLeaseIdentity,180000,JSON.stringify({owner:{pid:record.pid,host:hostname(),startedAt:record.startedAt},port:19483,mode:'supervised',supervisor:{kind:'schtasks',name:supervisor}})));}
    }),{env,path:databasePath});
  }
  try{
    child=await recordChild();
    if(row.id==='same-owner-replaced-pid')replacement=await recordChild();
    databasePath=resolveOpenClawStateSqlitePath(env);
    coordinator=acquireGatewayLifecycleCoordinator({databasePath});
    changeLease(row.id==='stale-incarnation'?{...child,startedAt:child.startedAt-1}:child);
    const first=readGatewayOwnerLease({env,current:true});
    assert.equal(first.owner,identity.owner);
    assert.equal(first.state,row.id==='stale-incarnation'?'dead':'live');
    row.initialLease=first;
    cp.spawnSync=function(executable,args,options){
      const name=String(executable).toLowerCase();
      if(row.id==='degraded-cim-tasklist' && args?.some(arg=>String(arg).includes('Get-CimInstance Win32_Process'))){
        degradedCalls++;
        return nativeSpawnSync(executable,args.map(arg=>String(arg).includes('Get-CimInstance Win32_Process')?"function Get-CimInstance { throw 'pr119052 native CIM failure' }; "+arg:arg),options);
      }
      if(name.endsWith('taskkill.exe')||name.endsWith('tasklist.exe')){
        const at=Date.now();const result=nativeSpawnSync(executable,args,options);
        commands.push({executable:path.basename(executable),args,at,elapsedMs:Date.now()-at,status:result.status,error:result.error?.code??null});
        if(name.endsWith('taskkill.exe')){
          if(args.includes('/F'))forcedAt=Date.now();
          else if(row.id==='released-same-incarnation')changeLease(null);
          else if(row.id==='same-owner-changed-incarnation')changeLease({...child,startedAt:child.startedAt+1});
          else if(row.id==='same-owner-changed-supervisor')changeLease(child,env.OPENCLAW_WINDOWS_TASK_NAME+'-replacement');
          else if(row.id==='same-owner-replaced-pid')changeLease(replacement);
          else if(row.id==='owner-token-replacement')changeLease(child,env.OPENCLAW_WINDOWS_TASK_NAME,identity.owner+'-successor');
        }
        return result;
      }
      return nativeSpawnSync(executable,args,options);
    };syncBuiltinESMExports();
    const began=Date.now();
    if(row.id==='degraded-cim-tasklist'){
      assert.equal(probeProcessState(child.pid),'alive');
      assert.ok(degradedCalls>0);assert.ok(commands.some(c=>c.executable.toLowerCase()==='tasklist.exe'&&c.status===0));
      row.actual='native-tasklist-alive';
    }else if(row.id.startsWith('same-owner-')||row.id==='owner-token-replacement'){
      await assert.rejects(terminateScheduledTaskGatewayListeners(env,{port:19483,probeHosts:['127.0.0.1']}),/Gateway owner changed before terminating/);
      assert.equal(readWindowsProcessStartTimeSync(child.pid,5000,env),child.startedAt,'Original process incarnation must survive refusal');
      if(replacement)assert.equal(readWindowsProcessStartTimeSync(replacement.pid,5000,env),replacement.startedAt,'Replacement must remain alive');
      assert.equal(commands.filter(c=>c.executable.toLowerCase()==='taskkill.exe').length,1);
      assert.equal(commands.some(c=>c.args.includes('/F')),false);
      row.actual='changed-owner-refused-before-force';
    }else{
      const result=await terminateScheduledTaskGatewayListeners(env,{port:19483,probeHosts:['127.0.0.1']});
      if(row.id==='stale-incarnation'){
        assert.deepEqual(result,[]);assert.equal(readWindowsProcessStartTimeSync(child.pid,5000,env),child.startedAt);
        assert.equal(commands.filter(c=>c.executable.toLowerCase()==='taskkill.exe').length,0);row.actual='stale-incarnation-preserved';
      }else{
        assert.deepEqual(result,[child.pid]);assert.ok(forcedAt!==undefined,'Real actor must require forced taskkill for this cell');
        assert.equal(probeProcessState(child.pid),'missing');
        row.forcedReturnMs=Date.now()-forcedAt;assert.ok(row.forcedReturnMs<=18000,'15-second wait plus bounded tasklist command allowance');
        assert.ok(commands.some(c=>c.executable.toLowerCase()==='tasklist.exe'&&c.at>=forcedAt&&c.status===0));
        row.actual='forced-native-exit-verified';
      }
    }
    row.elapsedMs=Date.now()-began;row.commands=commands;row.degradedCalls=degradedCalls;row.status='PASS_PENDING_CLEANUP';
  }catch(error){row.status='FAIL';row.error=String(error.stack??error);row.commands=commands;}
  finally{
    cp.spawnSync=nativeSpawnSync;syncBuiltinESMExports();
    const cleanupErrors=[];
    for(const item of identities){
      try{
        if(item.spawnError && item.pid===undefined)continue;
        // ChildProcess retains the native process handle. PID-only lookups can
        // outlive termination or identify a reused PID; they are not kill authority.
        if(item.child.exitCode===null && item.child.signalCode===null)item.child.kill('SIGKILL');
        const deadline=Date.now()+15000;
        while(item.child.exitCode===null && item.child.signalCode===null && Date.now()<deadline)await sleep(100);
        assert.ok(item.child.exitCode!==null || item.child.signalCode!==null,'Owned native actor handle did not exit');
      }catch(error){cleanupErrors.push(String(error.stack??error));}
    }
    if(databasePath){
      try{changeLease(null);}catch(error){cleanupErrors.push(String(error.stack??error));}
      try{await closeOpenClawStateDatabaseByPathAsync(databasePath);}catch(error){cleanupErrors.push(String(error.stack??error));}
    }
    try{coordinator?.release();coordinator=undefined;}catch(error){cleanupErrors.push(String(error.stack??error));}
    if(cleanupErrors.length===0){
      try{
        await fs.rm(cellRoot,{recursive:true});assert.equal(await fs.stat(cellRoot).then(()=>true,()=>false),false);
        row.cleanup={ownProcessesAbsent:true,leaseReleased:true,stateRemoved:true};
        if(row.status==='PASS_PENDING_CLEANUP')row.status='PASS';
      }catch(error){cleanupErrors.push(String(error.stack??error));}
    }
    if(cleanupErrors.length){row.status='FAIL';row.cleanupErrors=cleanupErrors;}
    await save();
  }
  if(row.status!=='PASS')break;
}
summary.status=summary.cells.every(row=>row.status==='PASS')?'PASS':'INCOMPLETE';await save();if(summary.status!=='PASS')process.exitCode=1;
