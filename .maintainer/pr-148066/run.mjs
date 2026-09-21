import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root, sha256, manifest } from './loader.mjs';
const { resolveServiceManagerEnv } = await import('./source-exact/src/daemon/service-process-env.ts');
assert.equal(process.platform,'win32');assert.equal(process.version,'v24.20.0');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
const order=process.argv[2];assert(['forward','reverse'].includes(order));
const proof=path.join(process.env.RUNNER_TEMP,'pr148066-windows-'+order);
fs.mkdirSync(proof);
const volume=fs.statfsSync(process.env.RUNNER_TEMP);
const free=Number(volume.bavail)*Number(volume.bsize);
assert(free>64*1024**2,'Measured space must fit bounded diagnostic artifacts');
const nativeTemp=fs.realpathSync.native(process.env.TMPDIR||process.env.TMP||process.env.TEMP||os.tmpdir());
const namespace=fs.mkdtempSync(path.join(nativeTemp,'oc-vt-'));
const nativeHome=path.join(namespace,'home');fs.mkdirSync(nativeHome);
const childEnv={...resolveServiceManagerEnv(),TMPDIR:namespace,TMP:namespace,TEMP:namespace,HOME:nativeHome,USERPROFILE:nativeHome};
const receipt={workflowSha:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,runner:{name:process.env.RUNNER_NAME,image:process.env.ImageOS,imageVersion:process.env.ImageVersion,environment:process.env.RUNNER_ENVIRONMENT,os:os.release(),arch:os.arch(),cpuCount:os.cpus().length,availableParallelism:os.availableParallelism(),totalMemory:os.totalmem()},manifestSha256:sha256(fs.readFileSync(path.join(root,'source-manifest.json'))),source:manifest.originalSource,order,freeBytes:free,namespace,nativeHome,started:new Date().toISOString(),driverSha256:sha256(fs.readFileSync(new URL(import.meta.url))),maxOuterBytes:2*1024**2,outerTimeoutMs:120000};
fs.writeFileSync(path.join(proof,'driver.json'),JSON.stringify(receipt,null,2));
const child=spawn(process.execPath,[path.join(root,'probe.mjs'),proof,order],{env:childEnv,windowsHide:false,stdio:['ignore','pipe','pipe']});
receipt.pid=child.pid;let total=0;let overflow=false;let timedOut=false;
const capture=(stream,file)=>stream.on('data',b=>{total+=b.length;if(total>receipt.maxOuterBytes){overflow=true;child.kill();return;}fs.appendFileSync(path.join(proof,file),b);});
capture(child.stdout,'outer-stdout.log');capture(child.stderr,'outer-stderr.log');
const timer=setTimeout(()=>{timedOut=true;child.kill();},receipt.outerTimeoutMs);
const settled=await new Promise(resolve=>{child.once('error',e=>resolve({error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}));});
clearTimeout(timer);Object.assign(receipt,{ended:new Date().toISOString(),...settled,timedOut,overflow,totalBytes:total});
// Delete only this namespace, only after joined synchronous probes prove their PIDs absent.
let evidence;try{evidence=JSON.parse(fs.readFileSync(path.join(proof,'probe-results.json'),'utf8'));}catch{}
const probes=evidence?.records?.filter(r=>r.kind==='powershell-probe')??[];
const clean=settled.code!==null&&!timedOut&&!overflow&&evidence?.complete&&probes.length===5&&probes.every(p=>p.pidGone===true)&&evidence.postProbeIdentity?.pidGone===true;
if(clean){fs.rmSync(namespace,{recursive:true});receipt.cleanup={namespaceRemoved:!fs.existsSync(namespace)};}
else receipt.cleanup={namespaceRemoved:false,retainedReason:'Uncertain child/probe completion; ephemeral runner teardown remains owner',path:namespace};
fs.writeFileSync(path.join(proof,'driver.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({order,source:manifest.originalSource,code:settled.code,timedOut,overflow,baselineAssertionSatisfied:evidence?.baselineAssertionSatisfied,cleanup:receipt.cleanup}));
if(settled.code!==0||timedOut||overflow||!clean)process.exitCode=1;
