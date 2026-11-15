import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRootOwnedPath, validatePromotionApproval } from './promote-release.mjs';
import { validateStagedRelease } from './stage-release.mjs';
import { verifyReleaseSource } from './verify-release-source.mjs';

const tools='/opt/itsm/tools/release';
const installedPaths=Object.freeze({tools,releases:'/opt/itsm/releases',
  approvals:'/opt/itsm/shared/deployment-approvals',executions:'/opt/itsm/shared/deployment-executions',
  state:'/opt/itsm/shared/release-state',env:'/opt/itsm/shared/development.env',
  token:'/etc/itsm/github-actions-read.token'});
const trustedTools=['execute-approved-deployment.mjs','promote-release.mjs','stage-release.mjs',
  'release.mjs','verify-release-source.mjs','extract-release.py'];
const sourceKeys=['sha','runId','runAttempt','artifactId','artifactDigest','artifactSize'];
const imageNames=['api','web','worker','postgres','redis'];

export function validateDeploymentApproval(approval,requestId,now=Date.now()) {
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId) || approval?.requestId !== requestId
    || approval.operation !== 'deploy-development' || approval.verifyDevelopment !== true
    || !(approval.expectedCurrentSha === null || /^[a-f0-9]{40}$/.test(approval.expectedCurrentSha ?? '')))
    throw new Error('EXACT_DEVELOPMENT_DEPLOYMENT_APPROVAL_REQUIRED');
  return validatePromotionApproval(approval,approval.sha,approval.runId,now);
}

async function readPrivate(path,limit=16384) {
  await requireRootOwnedPath(path,{privateFile:true});
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info=await file.stat();
    if (info.uid !== 0 || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > limit)
      throw new Error('PRIVATE_ROOT_FILE_REQUIRED');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function currentState(paths) {
  let text;
  try { text=await readPrivate(join(paths.state,'current.json'),128*1024); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const current=JSON.parse(text);
  if (!/^[a-f0-9]{40}$/.test(current?.sha ?? '')) throw new Error('INVALID_CURRENT_RELEASE_STATE');
  return current;
}

async function verifyPrivateTree(directory) {
  await requireRootOwnedPath(directory,{directory:true,privateFile:true});
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path=join(directory,entry.name);
    if (entry.isDirectory()) await verifyPrivateTree(path);
    else await requireRootOwnedPath(path,{privateFile:true});
  }
}

export function releaseInvocation(bundle,args) {
  return {command:'/usr/bin/node',args:[join(bundle,'scripts/release.mjs'),...args],options:{
    cwd:bundle,env:{PATH:'/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8',DOCKER_CONFIG:'/root/.docker',
      DOCKER_HOST:'unix:///var/run/docker.sock'},stdio:['ignore','pipe','pipe'],detached:true,
  }};
}

function runRelease(bundle,args) {
  return new Promise((done,fail) => {
    const invocation=releaseInvocation(bundle,args);
    const child=spawn(invocation.command,invocation.args,invocation.options);
    let output='',bytes=0,overflow=false,timedOut=false,killTimer;
    const stop=signal => {
      if (!child.pid) return;
      try { process.kill(-child.pid,signal); } catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    const timer=setTimeout(() => {
      timedOut=true;
      stop('SIGTERM');
      killTimer=setTimeout(() => stop('SIGKILL'),5000); killTimer.unref();
    },1800000);
    timer.unref();
    child.stdout.on('data',chunk => {
      bytes+=chunk.length;
      if (bytes > 1024*1024) { overflow=true; stop('SIGKILL'); }
      else output+=chunk;
    });
    child.stderr.resume();
    child.once('error',() => { clearTimeout(timer); fail(new Error('FIXED_RELEASE_EXECUTOR_UNAVAILABLE')); });
    child.once('close',code => {
      if (timedOut || overflow) stop('SIGKILL');
      clearTimeout(timer); clearTimeout(killTimer);
      code === 0 && !overflow && !timedOut ? done(output.trim()) : fail(new Error('APPROVED_RELEASE_EXECUTION_FAILED'));
    });
  });
}

async function updateReceipt(path,value) {
  const temporary=`${path}.${process.pid}.tmp`;
  await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{flag:'wx',mode:0o600});
  await rename(temporary,path);
}

export async function executeApprovedDeployment(requestId,{paths=installedPaths,now=Date.now,
  verifySource=verifyReleaseSource,execute=runRelease,checkRuntime=true}={}) {
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error('ROOT_DEPLOYMENT_REQUIRED');
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) throw new Error('EXACT_DEPLOYMENT_REQUEST_ID_REQUIRED');
  for (const directory of [paths.tools,paths.releases])
    await requireRootOwnedPath(directory,{directory:true});
  for (const directory of [paths.approvals,paths.executions,paths.state])
    await requireRootOwnedPath(directory,{directory:true,privateFile:true});
  for (const name of trustedTools) await requireRootOwnedPath(join(paths.tools,name));
  await requireRootOwnedPath(paths.env,{privateFile:true});
  if (checkRuntime) for (const binary of ['/usr/bin/node','/usr/bin/docker']) await requireRootOwnedPath(binary);
  const requestPath=join(paths.approvals,`${requestId}.json`);
  const requestText=await readPrivate(requestPath);
  const approval=validateDeploymentApproval(JSON.parse(requestText),requestId,now());
  const bundle=join(paths.releases,approval.sha);
  const promotion=JSON.parse(await readPrivate(join(paths.releases,`${approval.sha}.promotion.json`)));
  if (promotion.repository !== approval.repository || promotion.verificationLevel !== 'approved-root-promoted'
    || promotion.deploymentPerformed !== false || promotion.bundlePath !== bundle
    || sourceKeys.some(key => promotion[key] !== approval[key])) throw new Error('APPROVED_PROMOTION_BINDING_REQUIRED');
  await verifyPrivateTree(bundle);
  const manifest=await validateStagedRelease(bundle,approval);
  if (promotion.schemaFingerprint !== manifest.schemaFingerprint
    || imageNames.some(name => promotion.images?.[name] !== manifest.images[name]))
    throw new Error('APPROVED_PROMOTION_BINDING_REQUIRED');
  const receiptPath=join(paths.executions,`${requestId}.json`),lock=join(paths.executions,'operation.lock');
  await mkdir(lock,{mode:0o700});
  let receipt;
  try {
    const token=(await readPrivate(paths.token,8192)).trim();
    if (!token || /[\r\n]/.test(token)) throw new Error('GITHUB_READ_IDENTITY_REQUIRED');
    const source=await verifySource({sha:approval.sha,runId:approval.runId,token});
    if (source.repository !== approval.repository || source.verificationLevel !== 'github-source-only'
      || sourceKeys.some(key => source[key] !== approval[key])) throw new Error('APPROVED_RELEASE_SOURCE_MISMATCH');
    if (await readPrivate(requestPath) !== requestText) throw new Error('DEPLOYMENT_APPROVAL_CHANGED');
    validateDeploymentApproval(approval,requestId,now());
    if (((await currentState(paths))?.sha ?? null) !== approval.expectedCurrentSha)
      throw new Error('DEPLOYMENT_BASELINE_CHANGED');
    const initialReceipt={version:1,requestId,repository:approval.repository,sha:approval.sha,runId:approval.runId,
      runAttempt:approval.runAttempt,artifactId:approval.artifactId,artifactDigest:approval.artifactDigest,
      approvedBy:approval.approvedBy,approvalRef:approval.approvalRef,expectedCurrentSha:approval.expectedCurrentSha,
      status:'running',phase:'deploy',startedAt:new Date(now()).toISOString()};
    // A receipt consumes this approval before any application or database change. Retries need a new approval.
    await writeFile(receiptPath,`${JSON.stringify(initialReceipt,null,2)}\n`,{flag:'wx',mode:0o600});
    receipt=initialReceipt;
    await execute(bundle,['deploy',approval.sha,'--verify-development']);
    const deployed=await currentState(paths);
    if (deployed?.sha !== approval.sha || deployed.verificationLevel !== 'synthetic-business'
      || deployed.businessAcceptance?.status !== 'passed'
      || imageNames.some(name => deployed.images?.[name] !== manifest.images[name]))
      throw new Error('DEPLOYMENT_BUSINESS_EVIDENCE_REQUIRED');
    receipt.phase='backup'; await updateReceipt(receiptPath,receipt);
    const backupOutput=await execute(bundle,['backup']);
    const match=/^Backup verified: (.+)$/.exec(backupOutput);
    const backupDirectory=join(paths.state,'backups');
    const backup=match?.[1];
    if (!backup || dirname(backup) !== backupDirectory || !/^itsm-[A-Za-z0-9-]+\.dump$/.test(backup.slice(backupDirectory.length+1)))
      throw new Error('FIXED_BACKUP_EVIDENCE_REQUIRED');
    await requireRootOwnedPath(backupDirectory,{directory:true,privateFile:true});
    await requireRootOwnedPath(backup,{privateFile:true});
    const metadata=JSON.parse(await readPrivate(`${backup}.json`));
    if (metadata.file !== backup || metadata.release !== approval.sha || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? ''))
      throw new Error('FIXED_BACKUP_EVIDENCE_REQUIRED');
    receipt.backup={path:backup,sha256:metadata.sha256};
    receipt.phase='restore-check'; await updateReceipt(receiptPath,receipt);
    await execute(bundle,['restore-check','--backup',backup]);
    if ((await currentState(paths))?.sha !== approval.sha) throw new Error('DEPLOYMENT_BASELINE_CHANGED');
    receipt={...receipt,status:'succeeded',phase:'complete',images:manifest.images,
      businessAcceptance:deployed.businessAcceptance,restoreCheck:'isolated-schema-and-ticket-reads',
      completedAt:new Date(now()).toISOString()};
    await updateReceipt(receiptPath,receipt);
    return receipt;
  } catch (error) {
    if (receipt) await updateReceipt(receiptPath,{...receipt,status:'failed',
      error:/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'APPROVED_DEPLOYMENT_FAILED',
      completedAt:new Date(now()).toISOString()}).catch(() => {});
    throw error;
  } finally { await rm(lock,{recursive:true}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [requestId,...extra]=process.argv.slice(2);
  Promise.resolve().then(() => {
    if (extra.length || dirname(fileURLToPath(import.meta.url)) !== tools)
      throw new Error('INSTALLED_FIXED_DEPLOYMENT_ENTRY_REQUIRED');
    return executeApprovedDeployment(requestId);
  }).then(result => console.log(JSON.stringify(result,null,2))).catch(error => {
    console.error(/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'APPROVED_DEPLOYMENT_FAILED');
    process.exitCode=1;
  });
}
