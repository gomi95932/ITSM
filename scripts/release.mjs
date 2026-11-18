import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const recoveryMethod='isolated-public-table-data-v1';
const inventoryMethod='public-table-chunked-sha256-v1';
// Bound each aggregate to 1024 row hashes; PostgreSQL can spill the preceding sort to disk.
const inventorySql=String.raw`
SELECT format($query$
  SELECT json_build_object('schema',%L,'table',%L,
    'rows',COALESCE(sum(row_count),0)::text,
    'sha256',encode(sha256(convert_to(COALESCE(string_agg(chunk_hash,'' ORDER BY chunk),''),'UTF8')),'hex'))
  FROM (
    SELECT chunk,count(*) AS row_count,
      encode(sha256(convert_to(string_agg(row_hash,'' ORDER BY row_hash COLLATE "C"),'UTF8')),'hex') AS chunk_hash
    FROM (
      SELECT row_hash,(row_number() OVER (ORDER BY row_hash COLLATE "C")-1)/1024 AS chunk
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_hash
        FROM ONLY %I.%I t) hashed
    ) ordered GROUP BY chunk
  ) chunks
$query$,n.nspname,c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
ORDER BY c.relname COLLATE "C"
\gexec
`;
const inventoryTransaction=String.raw`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL timezone='UTC';
SET LOCAL datestyle='ISO, YMD';
SET LOCAL intervalstyle='postgres';
SET LOCAL bytea_output='hex';
SET LOCAL extra_float_digits=3;
`;

export function inventoryFingerprint(inventory) {
  if (!Array.isArray(inventory) || inventory.length > 10000) throw new Error('INVALID_BACKUP_INVENTORY');
  const names=new Set();
  const rows=inventory.map(row => {
    if (row?.schema !== 'public' || typeof row.table !== 'string' || !row.table.length
      || typeof row.rows !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.rows)
      || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || names.has(row.table))
      throw new Error('INVALID_BACKUP_INVENTORY');
    names.add(row.table);
    return {schema:row.schema,table:row.table,rows:row.rows,sha256:row.sha256};
  }).sort((a,b) => a.table < b.table ? -1 : a.table > b.table ? 1 : 0);
  return sha256(JSON.stringify(rows));
}

export function validateRecoveryProof(metadata,proof) {
  const fingerprint=inventoryFingerprint(metadata?.inventory);
  if (metadata.inventoryMethod !== inventoryMethod || metadata.inventorySha256 !== fingerprint
    || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? '')
    || proof?.method !== recoveryMethod || proof.status !== 'passed'
    || proof.backupSha256 !== metadata.sha256 || proof.inventorySha256 !== fingerprint
    || proof.tableCount !== metadata.inventory.length || !Number.isFinite(Date.parse(proof.verifiedAt)))
    throw new Error('RESTORE_DATA_EVIDENCE_REQUIRED');
  return fingerprint;
}

function parseInventory(output) {
  const lines=output.split('\n').filter(line => line.trim());
  const completed=JSON.parse(lines.pop() ?? 'null');
  if (completed?.inventoryCompleted !== true) throw new Error('INCOMPLETE_BACKUP_INVENTORY');
  const inventory=lines.map(line => JSON.parse(line));
  inventoryFingerprint(inventory);
  return inventory;
}

async function fileHash(path) {
  const file=await open(path,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(256*1024);
  try {
    let result;
    while ((result=await file.read(buffer,0,buffer.length,null)).bytesRead)
      hash.update(buffer.subarray(0,result.bytesRead));
    return hash.digest('hex');
  } finally { await file.close(); }
}
export const schemaFingerprint = files => sha256(JSON.stringify(files.filter(f => f.path.startsWith('db/migrations/')).sort((a,b) => a.path.localeCompare(b.path))));
export const requiredReleaseFiles = Object.freeze([
  'infra/compose/compose.yaml',
  'scripts/release.mjs',
  'scripts/create-development-env.mjs',
  'docs/release-runbook.md',
  'db/migrations/001_ticket_core.sql',
]);

export function validateConfig(config) {
  if (config.name !== 'itsm-dev') throw new Error('UNEXPECTED_COMPOSE_PROJECT');
  for (const name of ['db', 'redis', 'api', 'worker', 'migrate'])
    if (config.services[name]?.ports?.length) throw new Error('INTERNAL_SERVICE_PORT_EXPOSED');
  const ports = config.services.web?.ports;
  if (ports?.length !== 1 || ports[0].host_ip !== '127.0.0.1' || !/^\d+$/.test(String(ports[0].published)))
    throw new Error('WEB_MUST_BIND_LOOPBACK');
  for (const password of [config.services.db.environment.POSTGRES_PASSWORD, config.services.redis.environment.ITSM_REDIS_PASSWORD])
    if (typeof password !== 'string' || password.length < 24 || password.startsWith('replace-')) throw new Error('PRIVATE_RANDOM_CREDENTIALS_REQUIRED');
  if (config.services.migrate.environment.NODE_ENV === 'production' && config.services.migrate.environment.ITSM_SEED_DEV_DATA === 'true')
    throw new Error('PRODUCTION_SEED_FORBIDDEN');
  return Number(ports[0].published);
}

export function validateBusinessAcceptanceConfig(config) {
  if (config.services.api?.environment?.NODE_ENV !== 'development'
    || config.services.api?.environment?.ENABLE_DEV_AUTH !== 'true'
    || config.services.migrate?.environment?.ITSM_SEED_DEV_DATA !== 'true'
    || config.services.api?.environment?.NOTIFICATION_MODE !== 'fake'
    || config.services.worker?.environment?.NOTIFICATION_MODE !== 'fake'
    || config.services.worker?.environment?.ENABLE_LIVE_NOTIFICATIONS !== 'false')
    throw new Error('ISOLATED_SYNTHETIC_ACCEPTANCE_CONFIG_REQUIRED');
}

export function validateRuntimeContainer(container, expectedImage, service) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedImage ?? '') || container.Image !== expectedImage)
    throw new Error('RUNNING_IMAGE_MISMATCH');
  const labels=container.Config?.Labels;
  if (labels?.['com.docker.compose.project'] !== 'itsm-dev'
    || labels?.['com.docker.compose.service'] !== service
    || labels?.['com.docker.compose.oneoff']?.toLowerCase() !== 'false')
    throw new Error('RUNNING_CONTAINER_SCOPE_MISMATCH');
  if (container.State?.Running !== true || container.State?.Health?.Status !== 'healthy')
    throw new Error('RUNNING_CONTAINER_NOT_HEALTHY');
}

export async function validateRelease(directory, expected, { requireBusinessAcceptance = false } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expected ?? '')) throw new Error('FULL_COMMIT_SHA_REQUIRED');
  const base=await realpath(directory);
  if (!(await lstat(resolve(directory,'release.json'))).isFile()) throw new Error('INVALID_RELEASE_MANIFEST');
  const manifest = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8'));
  if (manifest.sha !== expected || manifest.repository !== 'gomi95932/ITSM' || manifest.ref !== 'refs/heads/main') throw new Error('UNAPPROVED_RELEASE');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('EMPTY_RELEASE');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || (!/^[A-Za-z0-9_./-]+$/.test(file.path)
      && file.path !== 'infra/systemd/itsm-deploy-approved@.service')
      || file.path.startsWith('/') || file.path.split('/').includes('..') || seen.has(file.path)) throw new Error('INVALID_RELEASE_PATH');
    seen.add(file.path);
    const path = resolve(directory, file.path);
    if (!(await realpath(path)).startsWith(`${base}${sep}`) || !(await lstat(path)).isFile() || sha256(await readFile(path)) !== file.sha256) throw new Error('RELEASE_CHECKSUM_MISMATCH');
  }
  for (const required of requiredReleaseFiles)
    if (!seen.has(required)) throw new Error('INCOMPLETE_RELEASE');
  if (requireBusinessAcceptance && !seen.has('scripts/verify-development.mjs'))
    throw new Error('HASHED_BUSINESS_ACCEPTANCE_TOOL_REQUIRED');
  if (schemaFingerprint(manifest.files) !== manifest.schemaFingerprint) throw new Error('SCHEMA_FINGERPRINT_MISMATCH');
  for (const name of ['api','web','worker','postgres','redis']) {
    if (!new RegExp(`^ghcr\\.io/gomi95932/itsm-${name}@sha256:[a-f0-9]{64}$`).test(manifest.images?.[name] ?? '')) throw new Error('IMMUTABLE_IMAGE_DIGEST_REQUIRED');
  }
  return manifest;
}

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd:root, env:options.env ?? process.env, stdio:[options.input ?? 'ignore', options.output ?? 'pipe', 'pipe'] });
    let killTimer,timedOut=false;
    const timer=setTimeout(() => { timedOut=true; child.kill('SIGTERM'); killTimer=setTimeout(() => child.kill('SIGKILL'),5000); killTimer.unref(); },900000);
    timer.unref();
    let output = '',bytes=0,overflow=false;
    child.stdout?.on('data', chunk => {
      bytes+=chunk.length;
      if (bytes > 1024*1024) { overflow=true; child.kill('SIGKILL'); }
      else output += chunk;
    });
    // Tool failures must not echo Compose configuration, database rows or credentials.
    child.stderr?.resume();
    if (options.textInput !== undefined) {
      child.stdin.on('error',() => {});
      child.stdin.end(options.textInput);
    }
    child.once('error', () => { clearTimeout(timer); fail(new Error('RELEASE_TOOL_UNAVAILABLE')); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(killTimer); code === 0 && !overflow && !timedOut ? done(output.trim()) : fail(new Error('RELEASE_TOOL_FAILED')); });
  });
}

export async function verifyRuntimeImages(images, containerIdFor) {
  const runtime={};
  for (const [service,imageName] of Object.entries({db:'postgres',redis:'redis',api:'api',worker:'worker',web:'web'})) {
    const id=await containerIdFor(service);
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('SINGLE_RUNNING_CONTAINER_REQUIRED');
    const expectedImage=await run('docker',['image','inspect',images[imageName],'--format','{{.Id}}']);
    const inspected=JSON.parse(await run('docker',['container','inspect',id]));
    if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error('SINGLE_RUNNING_CONTAINER_REQUIRED');
    validateRuntimeContainer(inspected[0],expectedImage,service);
    runtime[service]={containerId:id,imageId:expectedImage,image:images[imageName]};
  }
  return runtime;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value,null,2)}\n`, { mode:0o600, flag:'wx' });
  await rename(temporary,path);
}
async function optionalJson(path) {
  try { return JSON.parse(await readFile(path,'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function overrides(images) {
  return {ITSM_API_IMAGE:images.api,ITSM_WEB_IMAGE:images.web,ITSM_WORKER_IMAGE:images.worker,ITSM_POSTGRES_IMAGE:images.postgres,ITSM_REDIS_IMAGE:images.redis};
}

export async function main(argv) {
  const [command, ...args] = argv;
  const options = {}, positionals = [];
  for (let i=0;i<args.length;i++) {
    if (args[i].startsWith('--')) {
      const key=args[i].slice(2);
      if (key === 'verify-development' && !options[key]) { options[key]=true; continue; }
      if (!['env','state','backup'].includes(key) || !args[i+1] || args[i+1].startsWith('--') || options[key]) throw new Error('INVALID_RELEASE_ARGUMENT');
      options[key]=args[++i];
    } else positionals.push(args[i]);
  }
  if (!['check','deploy','backup','restore-check','rollback'].includes(command)
    || positionals.length !== (command === 'deploy' ? 1 : 0)
    || (options.backup && command !== 'restore-check')
    || (options['verify-development'] && !['deploy','rollback'].includes(command))) throw new Error('INVALID_RELEASE_COMMAND');
  const envFile=resolve(options.env ?? '/opt/itsm/shared/development.env');
  const state=resolve(options.state ?? '/opt/itsm/shared/release-state');
  const envInfo=await lstat(envFile);
  if (!envInfo.isFile() || (envInfo.mode & 0o077) || ![0,process.getuid?.()].includes(envInfo.uid)) throw new Error('ENV_FILE_MUST_BE_PRIVATE_AND_OWNED');
  await mkdir(state,{ recursive:true,mode:0o700 });
  const stateInfo=await lstat(state);
  if (!stateInfo.isDirectory() || (stateInfo.mode & 0o077) || ![0,process.getuid?.()].includes(stateInfo.uid)) throw new Error('STATE_DIRECTORY_MUST_BE_PRIVATE');
  const lock=await open(resolve(state,'operation.lock'),'wx',0o600).catch(() => { throw new Error('RELEASE_OPERATION_ALREADY_LOCKED'); });
  let phase='preflight', backupPath, businessAcceptance;
  try {
  await lock.writeFile(`${process.pid}\n`);
  let pinned={};
  const baseEnv={...process.env};
  for (const line of (await readFile(envFile,'utf8')).split('\n')) {
    const key=/^([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (key) delete baseEnv[key];
  }
  const compose=(args,io={}) => run('docker',['compose','--project-name','itsm-dev','--env-file',envFile,'-f',resolve(root,'infra/compose/compose.yaml'),...args],{...io,env:{...baseEnv,...pinned}});
  const currentPath=resolve(state,'current.json'), previousPath=resolve(state,'previous.json');
    await run('docker',['info','--format','{{.ServerVersion}}']);
    const config=JSON.parse(await compose(['config','--format','json']));
    const port=validateConfig(config);
    if (options['verify-development']) validateBusinessAcceptanceConfig(config);
    const existing=await optionalJson(currentPath);
    if (options['verify-development'])
      await validateRelease(root,command === 'deploy' ? positionals[0] : existing?.sha,{requireBusinessAcceptance:true});
    const backup=async () => {
      const directory=resolve(state,'backups'); await mkdir(directory,{recursive:true,mode:0o700});
      const path=resolve(directory,`itsm-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
      const file=await open(path,'wx',0o600);
      let scratch,inventory;
      try {
        scratch=await compose(['exec','-T','db','sh','-ec','umask 077; mktemp -d /tmp/itsm-backup.XXXXXXXXXX']);
        if (!/^\/tmp\/itsm-backup\.[A-Za-z0-9]{10}$/.test(scratch)) throw new Error('INVALID_BACKUP_SCRATCH_PATH');
        // psql holds the exporting transaction open until pg_dump has consumed the same snapshot.
        const script=`${inventoryTransaction}
SELECT pg_export_snapshot() AS snapshot \\gset
\\setenv ITSM_BACKUP_SNAPSHOT :snapshot
${inventorySql}
\\! pg_dump -U itsm -d itsm -Fc --snapshot="$ITSM_BACKUP_SNAPSHOT" --file="$ITSM_BACKUP_DUMP"
\\if :SHELL_ERROR
SELECT 1/0;
\\endif
COMMIT;
SELECT '{"inventoryCompleted":true}';`;
        inventory=parseInventory(await compose(['exec','-T','db','sh','-ec',
          'umask 077; export PGPASSWORD="$POSTGRES_PASSWORD" ITSM_BACKUP_DUMP="$1/archive.dump"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U itsm -d itsm -f /dev/stdin',
          'sh',scratch],{input:'pipe',textInput:script}));
        await compose(['exec','-T','db','cat',`${scratch}/archive.dump`],{output:file.fd});
        await file.sync();
      } finally {
        await file.close();
        if (/^\/tmp\/itsm-backup\.[A-Za-z0-9]{10}$/.test(scratch ?? ''))
          await compose(['exec','-T','db','rm','-rf','--',scratch]);
      }
      const input=await open(path,'r');
      try { await compose(['exec','-T','db','pg_restore','--list'],{input:input.fd}); }
      finally { await input.close(); }
      await atomicJson(`${path}.json`,{file:path,sha256:await fileHash(path),createdAt:new Date().toISOString(),release:existing?.sha ?? null,
        inventoryMethod,inventory,inventorySha256:inventoryFingerprint(inventory)});
      return path;
    };
    const smoke=async () => {
      const base=`http://127.0.0.1:${port}`;
      const ready=await fetch(`${base}/api/v1/health/ready`,{signal:AbortSignal.timeout(10000)});
      if (!ready.ok || (await ready.json()).status !== 'ok') throw new Error('READINESS_CHECK_FAILED');
      const web=await fetch(base,{signal:AbortSignal.timeout(10000)});
      if (!web.ok || !(await web.text()).includes('id="app"')) throw new Error('WEB_SMOKE_FAILED');
    };
    const verifyRuntime=images => verifyRuntimeImages(images,service => compose(['ps','--status','running','-q',service]));
    const acceptBusiness=async () => {
      if (!options['verify-development']) return;
      // An explicit flag and isolated fake-only configuration authorize synthetic writes.
      const { verifyDevelopment }=await import('./verify-development.mjs');
      businessAcceptance=await verifyDevelopment({baseUrl:`http://127.0.0.1:${port}`,allowSyntheticWrites:true});
    };
    if (command === 'check') { console.log('Docker, private configuration and loopback isolation checks passed'); return; }
    if (command === 'backup') { backupPath=await backup(); console.log(`Backup verified: ${backupPath}`); return; }
    if (command === 'restore-check') {
      if (!options.backup) throw new Error('BACKUP_PATH_REQUIRED');
      const path=resolve(options.backup), metadata=JSON.parse(await readFile(`${path}.json`,'utf8'));
      if (!(await lstat(path)).isFile() || metadata.file !== path || await fileHash(path) !== metadata.sha256) throw new Error('BACKUP_CHECKSUM_MISMATCH');
      const expectedInventory=inventoryFingerprint(metadata.inventory);
      if (metadata.inventoryMethod !== inventoryMethod || metadata.inventorySha256 !== expectedInventory)
        throw new Error('BACKUP_SNAPSHOT_EVIDENCE_REQUIRED');
      const database=`itsm_restore_${Date.now()}_${process.pid}`;
      const sql=(query,db='postgres') => compose(['exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -X -v ON_ERROR_STOP=1 -U itsm -d "$1" -Atc "$2"','sh',db,query]);
      await sql(`CREATE DATABASE ${database}`);
      try {
        const input=await open(path,'r');
        try { await compose(['exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec pg_restore --exit-on-error --no-owner --no-acl -U itsm -d "$1"','sh',database],{input:input.fd}); }
        finally { await input.close(); }
        const script=`${inventoryTransaction}${inventorySql}COMMIT; SELECT '{"inventoryCompleted":true}';`;
        const restored=parseInventory(await compose(['exec','-T','db','sh','-ec',
          'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U itsm -d "$1" -f /dev/stdin',
          'sh',database],{input:'pipe',textInput:script}));
        if (inventoryFingerprint(restored) !== expectedInventory) throw new Error('RESTORED_TABLE_DATA_MISMATCH');
      } finally { await sql(`DROP DATABASE ${database}`); }
      const proof={method:recoveryMethod,status:'passed',backupSha256:metadata.sha256,
        inventorySha256:expectedInventory,tableCount:metadata.inventory.length,verifiedAt:new Date().toISOString()};
      validateRecoveryProof(metadata,proof);
      await atomicJson(`${path}.restore.json`,proof);
      console.log('Backup restored and public table data verified in an isolated temporary database');
      return;
    }
    if (command === 'rollback') {
      const previous=await optionalJson(previousPath);
      if (!existing || !previous || existing.schemaFingerprint !== previous.schemaFingerprint) throw new Error('SCHEMA_INCOMPATIBLE_ROLLBACK_REQUIRES_MANUAL_RECOVERY');
      const previousManifest=await validateRelease(previous.bundlePath,previous.sha);
      const composeHash=sha256(await readFile(resolve(root,'infra/compose/compose.yaml')));
      if (previousManifest.files.find(file => file.path === 'infra/compose/compose.yaml')?.sha256 !== composeHash) throw new Error('COMPOSE_INCOMPATIBLE_ROLLBACK_REQUIRES_MANUAL_RECOVERY');
      pinned=overrides(previousManifest.images);
      // Never change database/Redis images or re-run old migrations during application rollback.
      pinned.ITSM_POSTGRES_IMAGE=existing.images.postgres;
      pinned.ITSM_REDIS_IMAGE=existing.images.redis;
      phase='rollback'; await compose(['pull','api','web','worker']);
      await compose(['up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','api','worker','web']);
      phase='rollback-runtime-images';
      const rollbackImages={...previousManifest.images,postgres:existing.images.postgres,redis:existing.images.redis};
      await verifyRuntime(rollbackImages);
      phase='rollback-smoke';
      await smoke();
      phase='rollback-business-acceptance'; await acceptBusiness();
      phase='rollback-final-runtime-images';
      const runtime=await verifyRuntime(rollbackImages);
      const record={...previous,images:rollbackImages,digests:{...previous.digests,postgres:existing.digests.postgres,redis:existing.digests.redis},
        runtime,businessAcceptance:businessAcceptance ?? null,verificationLevel:businessAcceptance ? 'synthetic-business' : 'readiness-only',
        verifiedAt:new Date().toISOString()};
      await atomicJson(resolve(state,`rollback-${Date.now()}-${previous.sha}.json`),record);
      await atomicJson(previousPath,existing);
      await atomicJson(currentPath,record);
      console.log(`Application rollback verified: ${previous.sha}`); return;
    }
    const manifest=await validateRelease(root,positionals[0]);
    pinned=overrides(manifest.images);
    const running=await compose(['ps','--status','running','-q','db']);
    if (existing && !running) throw new Error('PREVIOUS_DATABASE_NOT_RUNNING');
    if (!existing) {
      const containers=await compose(['ps','-a','-q','db']);
      const volume=config.volumes?.itsm_pgdata?.name;
      if (typeof volume !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(volume)) throw new Error('UNEXPECTED_DATABASE_VOLUME');
      const volumes=await run('docker',['volume','ls','--format','{{.Name}}']);
      if (containers || volumes.split('\n').includes(volume)) throw new Error('EXISTING_STACK_REQUIRES_EXPLICIT_ADOPTION');
    }
    phase='pull'; await compose(['pull']);
    phase='quiesce'; await compose(['stop','web','api','worker']);
    if (running) { phase='backup'; backupPath=await backup(); }
    phase='data-services'; await compose(['up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','db','redis']);
    if (!running) { phase='backup'; backupPath=await backup(); }
    phase='migrate'; await compose(['run','--rm','--no-deps','migrate']);
    phase='start'; await compose(['up','-d','--no-build','--no-deps','--wait','--wait-timeout','180','api','worker','web']);
    phase='runtime-images'; await verifyRuntime(manifest.images);
    phase='smoke'; await smoke();
    phase='business-acceptance'; await acceptBusiness();
    phase='final-runtime-images'; const runtime=await verifyRuntime(manifest.images);
    const images={...manifest.images};
    const digests={};
    for (const [name,image] of Object.entries(images)) digests[name]=JSON.parse(await run('docker',['image','inspect',image,'--format','{{json .RepoDigests}}']));
    const record={sha:manifest.sha,bundlePath:root,schemaFingerprint:manifest.schemaFingerprint,images,digests,backup:backupPath,
      runtime,businessAcceptance:businessAcceptance ?? null,verificationLevel:businessAcceptance ? 'synthetic-business' : 'readiness-only',
      verifiedAt:new Date().toISOString()};
    await atomicJson(resolve(state,`release-${Date.now()}-${manifest.sha}.json`),record);
    if (existing) await atomicJson(previousPath,existing);
    await atomicJson(currentPath,record);
    console.log(`Development deployment verified: ${manifest.sha}`);
  } catch (error) {
    await atomicJson(resolve(state,`failure-${Date.now()}.json`),{phase,backup:backupPath ?? null,
      businessAcceptance:businessAcceptance ?? error.report ?? null,at:new Date().toISOString()}).catch(() => {});
    console.error(`Release stopped at ${phase}; no automatic database rollback was attempted`);
    throw error;
  } finally {
    await lock.close();
    const { unlink }=await import('node:fs/promises'); await unlink(resolve(state,'operation.lock'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_FAILED'); process.exitCode=1;
  });
}
