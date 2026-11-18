import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { requiredReleaseFiles, schemaFingerprint } from '../../scripts/release.mjs';

assert.equal(process.getuid(),0,'Only run in disposable Linux CI with sudo, never on the Mac or development server');
const checkout=fileURLToPath(new URL('../../',import.meta.url));
const sha='a'.repeat(40),requestId='d'.repeat(32),instant=Date.parse('2026-11-18T01:02:00Z');
const digest=value => createHash('sha256').update(value).digest('hex');
const tools=['inspect-development.mjs','release.mjs','promote-release.mjs','stage-release.mjs','verify-release-source.mjs'];

async function fixture(t) {
  const root=await mkdtemp('/run/itsm-inspection-test-');
  t.after(() => rm(root,{recursive:true,force:true}));
  const paths=Object.fromEntries(['tools','releases','state','executions'].map(name => [name,join(root,name)]));
  for (const directory of Object.values(paths)) await mkdir(directory,{mode:0o700});
  for (const name of tools) {
    const target=join(paths.tools,name);
    await copyFile(join(checkout,'scripts',name),target);
    await chown(target,0,0);
    await chmod(target,0o600);
  }
  const { requireRootOwnedPath }=await import(pathToFileURL(join(paths.tools,'promote-release.mjs')));
  for (const name of tools) {
    const path=join(paths.tools,name);
    try {
      await requireRootOwnedPath(path);
    } catch (error) {
      let cursor=path;
      const ancestors=[];
      while (true) {
        const info=await lstat(cursor);
        ancestors.push({path:cursor,uid:info.uid,mode:(info.mode & 0o7777).toString(8),
          links:info.nlink,file:info.isFile(),directory:info.isDirectory(),symlink:info.isSymbolicLink()});
        if (cursor === '/') break;
        cursor=dirname(cursor);
      }
      t.diagnostic(JSON.stringify({fixtureTrustFailure:ancestors}));
      throw error;
    }
  }
  const bundle=join(paths.releases,sha),files=[];
  for (const path of [...requiredReleaseFiles,'scripts/verify-development.mjs','db/migrations/002_inspection_fixture.sql']) {
    const target=join(bundle,path),content=`fixture ${path}`;
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
    files.push({path,sha256:digest(content)});
  }
  const images=Object.fromEntries(['api','web','worker','postgres','redis'].map(name =>
    [name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'b'.repeat(64)}`]));
  const manifest={repository:'gomi95932/ITSM',ref:'refs/heads/main',sha,runId:'123',runAttempt:2,
    images,files,schemaFingerprint:schemaFingerprint(files)};
  await writeFile(join(bundle,'release.json'),JSON.stringify(manifest),{mode:0o600});
  const source={repository:manifest.repository,runId:123,runAttempt:2,artifactId:456,artifactDigest:`sha256:${'c'.repeat(64)}`};
  const businessAcceptance={status:'passed',runId:'fixture-only',checks:['fixture-only'],completedAt:'2026-11-18T01:00:00Z'};
  const current={sha,bundlePath:bundle,images,schemaFingerprint:manifest.schemaFingerprint,
    verificationLevel:'synthetic-business',businessAcceptance};
  const backups=join(paths.state,'backups'); await mkdir(backups,{mode:0o700});
  const backup=join(backups,'itsm-2026-11-18T01-01-00-000Z.dump');
  await writeFile(backup,'synthetic-backup-bytes',{mode:0o600});
  const backupChecksum=digest('synthetic-backup-bytes');
  await writeFile(`${backup}.json`,JSON.stringify({file:backup,release:sha,sha256:backupChecksum}),{mode:0o600});
  const receipt={...source,sha,requestId,images,status:'succeeded',phase:'complete',businessAcceptance,
    restoreCheck:'isolated-schema-and-ticket-reads',completedAt:'2026-11-18T01:01:00Z',backup:{path:backup,sha256:backupChecksum}};
  const promotion={...source,sha,bundlePath:bundle,images,schemaFingerprint:manifest.schemaFingerprint,
    verificationLevel:'approved-root-promoted',deploymentPerformed:false};
  const records=[join(paths.state,'current.json'),join(paths.executions,`${requestId}.json`),join(paths.releases,`${sha}.promotion.json`)];
  for (const [index,value] of [current,receipt,promotion].entries())
    await writeFile(records[index],JSON.stringify(value),{mode:0o600});
  const containers={},imageIds={},ids={},calls=[];
  for (const [index,service] of ['db','redis','api','worker','web'].entries()) {
    const id=String(index+1).repeat(12),imageId=`sha256:${String(index+1).repeat(64)}`;
    ids[service]=id; imageIds[images[service === 'db' ? 'postgres' : service]]=imageId;
    containers[id]={Image:imageId,Config:{Env:['SECRET_SENTINEL=not-for-output'],Labels:{
      'com.docker.compose.project':'itsm-dev','com.docker.compose.service':service,'com.docker.compose.oneoff':'False'}},
      State:{Running:true,Health:{Status:'healthy'}}};
  }
  const rows=files.filter(file => file.path.startsWith('db/migrations/')).map(file =>
    ({name:file.path.slice('db/migrations/'.length),checksum:file.sha256}));
  // External processes are mocked; these fixtures prove private evidence and orchestration boundaries.
  const docker=async args => {
    calls.push([...args]);
    if (args[0] === 'ps') {
      const service=args.find(arg => arg.startsWith('label=com.docker.compose.service='))?.split('=').at(-1);
      assert.deepEqual(args,['ps','--filter','label=com.docker.compose.project=itsm-dev',
        '--filter',`label=com.docker.compose.service=${service}`,'--filter','label=com.docker.compose.oneoff=False','--format','{{.ID}}']);
      assert.ok(Object.hasOwn(ids,service)); return ids[service];
    }
    if (args[0] === 'image') {
      assert.deepEqual(args,['image','inspect',args[2],'--format','{{.Id}}']);
      assert.ok(Object.hasOwn(imageIds,args[2])); return imageIds[args[2]];
    }
    if (args[0] === 'container') {
      assert.deepEqual(args,['container','inspect',args[2]]);
      assert.ok(Object.hasOwn(containers,args[2])); return JSON.stringify([containers[args[2]]]);
    }
    assert.equal(args[0],'exec','Inspection must not mutate Docker state');
    assert.deepEqual(args.slice(0,6),['exec',ids.db,'sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh']);
    assert.equal(args[6],"SELECT COALESCE(json_agg(m ORDER BY name),'[]'::json) FROM (SELECT name,checksum FROM schema_migrations) m");
    assert.equal(args.length,7); return JSON.stringify(rows);
  };
  const fetchImpl=async (url,options) => {
    assert.equal(url,'http://127.0.0.1:8088/api/v1/health/ready');
    assert.equal(options.redirect,'error'); assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({status:'ok',service:'itsm-api'}));
  };
  const helpers=await import(pathToFileURL(join(paths.tools,'inspect-development.mjs')));
  return {root,paths,bundle,manifest,current,receipt,promotion,records,backup,containers,ids,rows,calls,
    inspect:helpers.inspectDevelopment,dependencies:{paths,docker,fetchImpl,now:() => instant}};
}

test('checks runtime and recorded evidence without changing records or exposing container secrets',async t => {
  const f=await fixture(t),before=await Promise.all(f.records.map(path => readFile(path,'utf8')));
  const report=await f.inspect({sha,requestId},f.dependencies);
  assert.equal(report.status,'passed'); assert.equal(report.sha,sha); assert.equal(report.requestId,requestId);
  assert.equal(report.verificationLevel,'read-only-runtime-and-recorded-evidence');
  assert.equal(report.checkedAt,new Date(instant).toISOString());
  assert.equal(report.source.verification,'recorded-at-approved-deployment');
  assert.deepEqual(report.migrations,f.rows.map(row => row.name).sort());
  assert.equal(report.backup.checksumVerifiedNow,true);
  assert.equal(report.backup.restoreVerification,'recorded-isolated-schema-and-ticket-reads');
  assert.equal(report.limitations.length,3);
  assert.equal(JSON.stringify(report).includes('SECRET_SENTINEL'),false);
  assert.deepEqual(await Promise.all(f.records.map(path => readFile(path,'utf8'))),before);
  assert.deepEqual(await readdir(f.paths.executions),[`${requestId}.json`]);
  assert.equal(f.calls.filter(args => args[0] === 'ps').length,10);
  assert.equal(f.calls.filter(args => args[0] === 'exec').length,1);
});

test('rejects unsafe private records, tools, bundle files and backup links',async t => {
  for (const kind of ['ancestor','state','record','tool','bundle','backup-hardlink','record-symlink']) {
    const f=await fixture(t);
    if (kind === 'ancestor') await chmod(f.root,0o720);
    if (kind === 'state') await chmod(f.paths.state,0o755);
    if (kind === 'record') await chmod(f.records[0],0o644);
    if (kind === 'tool') await chmod(join(f.paths.tools,'release.mjs'),0o622);
    if (kind === 'bundle') await chmod(join(f.bundle,'scripts/release.mjs'),0o644);
    if (kind === 'backup-hardlink') await link(f.backup,join(f.root,'backup-link'));
    if (kind === 'record-symlink') {
      const original=join(f.root,'saved-current.json');
      await copyFile(f.records[0],original); await chmod(original,0o600);
      await rm(f.records[0]); await symlink(original,f.records[0]);
    }
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),/TRUSTED_ROOT_PATH_REQUIRED/);
  }
});

test('preserves existing release or executor locks without making external calls',async t => {
  for (const directory of ['state','executions']) {
    const f=await fixture(t),lock=join(f.paths[directory],'operation.lock');
    await writeFile(lock,'another-operation',{mode:0o600});
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),/DEPLOYMENT_OPERATION_IN_PROGRESS/);
    assert.equal(await readFile(lock,'utf8'),'another-operation'); assert.deepEqual(f.calls,[]);
  }
});

test('does not trust a failed receipt or a modified release file',async t => {
  for (const kind of ['receipt','checksum']) {
    const f=await fixture(t);
    if (kind === 'receipt') await writeFile(f.records[1],JSON.stringify({...f.receipt,status:'failed'}));
    if (kind === 'checksum') await writeFile(join(f.bundle,'scripts/release.mjs'),'tampered');
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),
      kind === 'receipt' ? /DEPLOYMENT_EVIDENCE_MISMATCH/ : /RELEASE_CHECKSUM_MISMATCH/);
    assert.deepEqual(f.calls,[]);
  }
});

test('rejects missing, unhealthy, wrong-scope and wrong-image containers',async t => {
  for (const kind of ['missing','multiple','health','scope','image']) {
    const f=await fixture(t),docker=f.dependencies.docker,api=f.containers[f.ids.api];
    if (kind === 'health') api.State.Health.Status='unhealthy';
    if (kind === 'scope') api.Config.Labels['com.docker.compose.project']='another-project';
    if (kind === 'image') api.Image=`sha256:${'f'.repeat(64)}`;
    if (['missing','multiple'].includes(kind)) f.dependencies.docker=async args =>
      args[0] === 'ps' ? kind === 'missing' ? '' : `${f.ids.api}\n${f.ids.web}` : docker(args);
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),{
      missing:/SINGLE_RUNNING_CONTAINER_REQUIRED/,multiple:/SINGLE_RUNNING_CONTAINER_REQUIRED/,
      health:/RUNNING_CONTAINER_NOT_HEALTHY/,scope:/RUNNING_CONTAINER_SCOPE_MISMATCH/,image:/RUNNING_IMAGE_MISMATCH/}[kind]);
  }
});

test('rejects ledger drift and failed or redirected readiness',async t => {
  for (const kind of ['missing-migration','checksum','extra-migration','http','body','redirect']) {
    const f=await fixture(t);
    if (kind === 'missing-migration') f.rows.pop();
    if (kind === 'checksum') f.rows[0].checksum='f'.repeat(64);
    if (kind === 'extra-migration') f.rows.push({name:'003_unreleased.sql',checksum:'f'.repeat(64)});
    if (kind === 'http') f.dependencies.fetchImpl=async () => new Response('unavailable',{status:503});
    if (kind === 'body') f.dependencies.fetchImpl=async () => new Response('{"status":"ok","service":"other-service"}');
    if (kind === 'redirect') f.dependencies.fetchImpl=async () => { throw new Error('REDIRECT_REJECTED'); };
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),kind.endsWith('migration') || kind === 'checksum'
      ? /MIGRATION_LEDGER_MISMATCH/ : kind === 'redirect' ? /REDIRECT_REJECTED/ : /CURRENT_READINESS_FAILED/);
  }
});

test('requires the recorded backup inside the fixed private backup directory with matching bytes',async t => {
  for (const kind of ['path','metadata','bytes']) {
    const f=await fixture(t);
    if (kind === 'path') await writeFile(f.records[1],JSON.stringify({...f.receipt,backup:{...f.receipt.backup,path:'/elsewhere/itsm.dump'}}));
    if (kind === 'metadata') await writeFile(`${f.backup}.json`,JSON.stringify({file:f.backup,release:'e'.repeat(40),sha256:f.receipt.backup.sha256}));
    if (kind === 'bytes') await writeFile(f.backup,'changed-backup');
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),kind === 'path' ? /RECORDED_BACKUP_REQUIRED/ : /RECORDED_BACKUP_MISMATCH/);
  }
});

test('detects deployment records, operation locks or container membership changing during inspection',async t => {
  for (const kind of ['record','lock','container']) {
    const f=await fixture(t),fetchImpl=f.dependencies.fetchImpl;
    f.dependencies.fetchImpl=async (...args) => {
      if (kind === 'record') await writeFile(f.records[0],JSON.stringify({...f.current,sha:'e'.repeat(40)}));
      if (kind === 'lock') await writeFile(join(f.paths.executions,'operation.lock'),'new-operation',{mode:0o600});
      if (kind === 'container') f.ids.api='f'.repeat(12);
      return fetchImpl(...args);
    };
    await assert.rejects(f.inspect({sha,requestId},f.dependencies),kind === 'lock'
      ? /DEPLOYMENT_OPERATION_IN_PROGRESS/ : /DEPLOYMENT_CHANGED_DURING_INSPECTION/);
    if (kind === 'lock') assert.equal(await readFile(join(f.paths.executions,'operation.lock'),'utf8'),'new-operation');
  }
});
