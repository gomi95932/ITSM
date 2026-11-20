import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireRootOwnedPath } from './promote-release.mjs';
import { recoveryMethod, validateEnterpriseReadinessEvidence, validateRecoveryProof, validateRelease, validateRuntimeContainer } from './release.mjs';

const installedTools='/opt/itsm/tools/release';
const installedPaths=Object.freeze({tools:installedTools,releases:'/opt/itsm/releases',
  state:'/opt/itsm/shared/release-state',executions:'/opt/itsm/shared/deployment-executions'});
const services=Object.freeze({db:'postgres',redis:'redis',api:'api',worker:'worker',web:'web'});
const readyUrl='http://127.0.0.1:8088/api/v1/health/ready';
const migrationSql="SELECT COALESCE(json_agg(m ORDER BY name),'[]'::json) FROM (SELECT name,checksum FROM schema_migrations) m";

export function validateInspectionSelection(sha,requestId) {
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)
    || typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId))
    throw new Error('EXACT_INSPECTION_SELECTION_REQUIRED');
}

export function validateInspectionEvidence({sha,requestId,bundle,current,receipt,promotion,manifest}) {
  validateInspectionSelection(sha,requestId);
  if (current?.sha !== sha || ![bundle,`${bundle}/`].includes(current.bundlePath) || manifest?.sha !== sha
    || promotion?.sha !== sha || promotion.bundlePath !== bundle || receipt?.sha !== sha
    || receipt.requestId !== requestId || receipt.status !== 'succeeded' || receipt.phase !== 'complete'
    || !['isolated-schema-and-ticket-reads',recoveryMethod].includes(receipt.restoreCheck)
    || promotion.verificationLevel !== 'approved-root-promoted' || promotion.deploymentPerformed !== false
    || promotion.repository !== 'gomi95932/ITSM' || receipt.repository !== promotion.repository
    || ![receipt.runId,receipt.runAttempt,receipt.artifactId].every(v => Number.isSafeInteger(v) && v > 0)
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.artifactDigest ?? '')
    || ['runId','runAttempt','artifactId','artifactDigest'].some(key => receipt[key] !== promotion[key])
    || Number(manifest.runId) !== receipt.runId || manifest.runAttempt !== receipt.runAttempt
    || current.schemaFingerprint !== manifest.schemaFingerprint || promotion.schemaFingerprint !== manifest.schemaFingerprint
    || Object.values(services).some(name => current.images?.[name] !== manifest.images?.[name]
      || receipt.images?.[name] !== manifest.images?.[name] || promotion.images?.[name] !== manifest.images?.[name]))
    throw new Error('DEPLOYMENT_EVIDENCE_MISMATCH');
  if (receipt.restoreCheck === recoveryMethod && manifest.recoveryVerification !== recoveryMethod)
    throw new Error('DEPLOYMENT_EVIDENCE_MISMATCH');
  if(current.verificationLevel==='enterprise-uat-readiness') {
    validateEnterpriseReadinessEvidence(current.enterpriseReadiness,receipt.configurationSha256);
    if(receipt.operation!=='deploy-enterprise-uat'||receipt.userAcceptance!=='pending'||
      current.businessAcceptance!=null||receipt.businessAcceptance!=null||
      JSON.stringify(current.enterpriseReadiness)!==JSON.stringify(receipt.enterpriseReadiness)||
      !Number.isFinite(Date.parse(receipt.startedAt))||!Number.isFinite(Date.parse(receipt.completedAt))||
      Date.parse(current.enterpriseReadiness.completedAt)<Date.parse(receipt.startedAt)||
      Date.parse(current.enterpriseReadiness.completedAt)>Date.parse(receipt.completedAt))
      throw new Error('RECORDED_ENTERPRISE_READINESS_REQUIRED');
    return;
  }
  const acceptance=current.businessAcceptance;
  if (current.verificationLevel !== 'synthetic-business' || acceptance?.status !== 'passed'
    || current.enterpriseReadiness!=null || receipt.enterpriseReadiness!=null
    || (receipt.operation!=null&&receipt.operation!=='deploy-development')
    || typeof acceptance.runId !== 'string' || !acceptance.runId.length
    || !Array.isArray(acceptance.checks) || !acceptance.checks.length
    || JSON.stringify(acceptance) !== JSON.stringify(receipt.businessAcceptance)
    || !Number.isFinite(Date.parse(acceptance.completedAt)) || !Number.isFinite(Date.parse(receipt.completedAt))
    || Date.parse(receipt.completedAt) < Date.parse(acceptance.completedAt))
    throw new Error('RECORDED_BUSINESS_ACCEPTANCE_REQUIRED');
}

export function validateMigrationLedger(manifest,rows) {
  const expected=manifest.files.filter(file => /^db\/migrations\/[^/]+\.sql$/.test(file.path))
    .map(file => ({name:file.path.slice('db/migrations/'.length),checksum:file.sha256}))
    .sort((a,b) => a.name.localeCompare(b.name));
  if (!expected.length || !Array.isArray(rows) || rows.length !== expected.length)
    throw new Error('MIGRATION_LEDGER_MISMATCH');
  const actual=[...rows].sort((a,b) => String(a?.name).localeCompare(String(b?.name)));
  if (actual.some((row,index) => row?.name !== expected[index].name || row.checksum !== expected[index].checksum))
    throw new Error('MIGRATION_LEDGER_MISMATCH');
  return expected.map(row => row.name);
}

async function privateFile(path,limit) {
  await requireRootOwnedPath(path,{privateFile:true});
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  const info=await file.stat();
  if (info.uid !== 0 || !info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > limit) {
    await file.close();
    throw new Error('PRIVATE_INSPECTION_FILE_REQUIRED');
  }
  return file;
}

async function privateText(path) {
  const file=await privateFile(path,1024*1024);
  try { return await file.readFile('utf8'); } finally { await file.close(); }
}

async function backupHash(path) {
  const file=await privateFile(path,Number.MAX_SAFE_INTEGER);
  try {
    const hash=createHash('sha256'),buffer=Buffer.alloc(256*1024);
    let result;
    while ((result=await file.read(buffer,0,buffer.length,null)).bytesRead)
      hash.update(buffer.subarray(0,result.bytesRead));
    return hash.digest('hex');
  } finally { await file.close(); }
}

export function inspectionDockerInvocation(args) {
  return {command:'/usr/bin/docker',args,options:{env:{PATH:'/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8',
    DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:'/root/.docker'},stdio:['ignore','pipe','pipe']}};
}

function runDocker(args) {
  return new Promise((done,fail) => {
    const invocation=inspectionDockerInvocation(args);
    const child=spawn(invocation.command,invocation.args,invocation.options);
    let output='',bytes=0,stopped=false;
    const stop=() => { stopped=true; child.kill('SIGKILL'); };
    const timer=setTimeout(stop,15000); timer.unref();
    child.stdout.on('data',chunk => { bytes+=chunk.length; if (bytes > 2*1024*1024) stop(); else output+=chunk; });
    child.stderr.resume();
    child.once('error',() => { clearTimeout(timer); fail(new Error('INSPECTION_DOCKER_UNAVAILABLE')); });
    child.once('close',code => {
      clearTimeout(timer);
      code === 0 && !stopped ? done(output.trim()) : fail(new Error('INSPECTION_DOCKER_FAILED'));
    });
  });
}

async function assertIdle(paths) {
  for (const path of [join(paths.state,'operation.lock'),join(paths.executions,'operation.lock')]) {
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('DEPLOYMENT_OPERATION_IN_PROGRESS');
  }
}

export async function inspectDevelopment({sha,requestId},{paths=installedPaths,docker=runDocker,fetchImpl=fetch,now=Date.now}={}) {
  validateInspectionSelection(sha,requestId);
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error('ROOT_INSPECTION_REQUIRED');
  for (const name of ['tools','releases','state','executions'])
    await requireRootOwnedPath(paths[name],{directory:true,privateFile:true});
  for (const name of ['inspect-development.mjs','release.mjs','promote-release.mjs','stage-release.mjs','verify-release-source.mjs'])
    await requireRootOwnedPath(join(paths.tools,name));
  await assertIdle(paths);
  const bundle=join(paths.releases,sha);
  const records=[join(paths.state,'current.json'),join(paths.executions,`${requestId}.json`),join(paths.releases,`${sha}.promotion.json`)];
  const texts=await Promise.all(records.map(privateText));
  const [current,receipt,promotion]=texts.map(text => JSON.parse(text));
  await requireRootOwnedPath(bundle,{directory:true,privateFile:true});
  await privateText(join(bundle,'release.json'));
  const enterprise=current.verificationLevel==='enterprise-uat-readiness';
  const manifest=await validateRelease(bundle,sha,{requireBusinessAcceptance:!enterprise,requireEnterpriseReadiness:enterprise});
  for (const file of manifest.files) await requireRootOwnedPath(join(bundle,file.path),{privateFile:true});
  validateInspectionEvidence({sha,requestId,bundle,current,receipt,promotion,manifest});
  const environmentPath=paths.env??'/opt/itsm/shared/development.env';
  const verifyConfiguration=async()=>{
    if(enterprise&&createHash('sha256').update(await privateText(environmentPath)).digest('hex')!==receipt.configurationSha256)
      throw new Error('ENTERPRISE_CONFIGURATION_DRIFT');
  };
  await verifyConfiguration();

  const runtime={};
  for (const [service,imageName] of Object.entries(services)) {
    const id=await docker(['ps','--filter','label=com.docker.compose.project=itsm-dev',
      '--filter',`label=com.docker.compose.service=${service}`,'--filter','label=com.docker.compose.oneoff=False','--format','{{.ID}}']);
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('SINGLE_RUNNING_CONTAINER_REQUIRED');
    const imageId=await docker(['image','inspect',manifest.images[imageName],'--format','{{.Id}}']);
    const inspected=JSON.parse(await docker(['container','inspect',id]));
    if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('SINGLE_RUNNING_CONTAINER_REQUIRED');
    validateRuntimeContainer(inspected[0],imageId,service);
    runtime[service]={containerId:id,image:manifest.images[imageName],imageId};
  }
  const rows=JSON.parse(await docker(['exec',runtime.db.containerId,'sh','-ec',
    'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',migrationSql]));
  const migrations=validateMigrationLedger(manifest,rows);
  const response=await fetchImpl(readyUrl,{redirect:'error',signal:AbortSignal.timeout(10000)});
  const health=await response.text();
  if (!response.ok || Buffer.byteLength(health) > 4096) throw new Error('CURRENT_READINESS_FAILED');
  const ready=JSON.parse(health);
  if (ready.status !== 'ok' || ready.service !== 'itsm-api') throw new Error('CURRENT_READINESS_FAILED');

  const backup=receipt.backup;
  if (typeof backup?.path !== 'string' || dirname(backup.path) !== join(paths.state,'backups')
    || !/^itsm-[A-Za-z0-9-]+\.dump$/.test(backup.path.slice(backup.path.lastIndexOf('/')+1))
    || !/^[a-f0-9]{64}$/.test(backup.sha256 ?? '')) throw new Error('RECORDED_BACKUP_REQUIRED');
  const metadata=JSON.parse(await privateText(`${backup.path}.json`));
  if (metadata.file !== backup.path || metadata.release !== sha || metadata.sha256 !== backup.sha256
    || await backupHash(backup.path) !== backup.sha256) throw new Error('RECORDED_BACKUP_MISMATCH');
  if (receipt.restoreCheck === recoveryMethod) {
    const proof=JSON.parse(await privateText(`${backup.path}.restore.json`));
    const inventorySha256=validateRecoveryProof(metadata,proof);
    if (receipt.recoveryEvidence?.inventorySha256 !== inventorySha256
      || receipt.recoveryEvidence?.tableCount !== proof.tableCount
      || receipt.recoveryEvidence?.verifiedAt !== proof.verifiedAt
      || !Number.isFinite(Date.parse(receipt.startedAt))
      || Date.parse(proof.verifiedAt) > Date.parse(receipt.completedAt)
      || Date.parse(proof.verifiedAt) < Date.parse(receipt.startedAt))
      throw new Error('RECORDED_RESTORE_EVIDENCE_MISMATCH');
  }
  await assertIdle(paths);
  for (let index=0;index<records.length;index++)
    if (await privateText(records[index]) !== texts[index]) throw new Error('DEPLOYMENT_CHANGED_DURING_INSPECTION');
  for (const [service,item] of Object.entries(runtime)) {
    const currentId=await docker(['ps','--filter','label=com.docker.compose.project=itsm-dev',
      '--filter',`label=com.docker.compose.service=${service}`,'--filter','label=com.docker.compose.oneoff=False','--format','{{.ID}}']);
    if (currentId !== item.containerId) throw new Error('DEPLOYMENT_CHANGED_DURING_INSPECTION');
    const inspected=JSON.parse(await docker(['container','inspect',item.containerId]));
    if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('SINGLE_RUNNING_CONTAINER_REQUIRED');
    validateRuntimeContainer(inspected[0],item.imageId,service);
  }
  await verifyConfiguration();
  return {status:'passed',verificationLevel:'read-only-runtime-and-recorded-evidence',repository:'gomi95932/ITSM',
    sha,requestId,checkedAt:new Date(now()).toISOString(),
    source:{runId:receipt.runId,runAttempt:receipt.runAttempt,artifactId:receipt.artifactId,
      artifactDigest:receipt.artifactDigest,verification:'recorded-at-approved-deployment'},
    runtime,migrations,readiness:{url:readyUrl,status:'ok'},
    recordedBusinessAcceptance:enterprise?null:{runId:current.businessAcceptance.runId,completedAt:current.businessAcceptance.completedAt},
    ...(enterprise?{recordedEnterpriseReadiness:current.enterpriseReadiness,userAcceptance:'pending'}:{}),
    backup:{path:backup.path,sha256:backup.sha256,checksumVerifiedNow:true,
      restoreVerification:`recorded-${receipt.restoreCheck}`,recordedAt:receipt.completedAt,
      ...(receipt.restoreCheck === recoveryMethod ? {dataIntegrity:receipt.recoveryEvidence} : {})},
    limitations:['No new business transaction or backup restore was executed.','GitHub source was not re-queried.',
      'This is a point-in-time check, not a deployment lock or production acceptance.']};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha,requestId,...extra]=process.argv.slice(2);
  Promise.resolve().then(() => {
    if (extra.length || dirname(fileURLToPath(import.meta.url)) !== installedTools)
      throw new Error('INSTALLED_FIXED_INSPECTION_ENTRY_REQUIRED');
    return inspectDevelopment({sha,requestId});
  }).then(report => console.log(JSON.stringify(report,null,2))).catch(error => {
    console.error(/^[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'DEVELOPMENT_INSPECTION_FAILED');
    process.exitCode=1;
  });
}
