import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const schemaFingerprint = files => sha256(JSON.stringify(files.filter(f => f.path.startsWith('db/migrations/')).sort((a,b) => a.path.localeCompare(b.path))));

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

export async function validateRelease(directory, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected ?? '')) throw new Error('FULL_COMMIT_SHA_REQUIRED');
  const base=await realpath(directory);
  if (!(await lstat(resolve(directory,'release.json'))).isFile()) throw new Error('INVALID_RELEASE_MANIFEST');
  const manifest = JSON.parse(await readFile(resolve(directory, 'release.json'), 'utf8'));
  if (manifest.sha !== expected || manifest.repository !== 'gomi95932/ITSM' || manifest.ref !== 'refs/heads/main') throw new Error('UNAPPROVED_RELEASE');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('EMPTY_RELEASE');
  const seen = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file.path)
      || file.path.startsWith('/') || file.path.split('/').includes('..') || seen.has(file.path)) throw new Error('INVALID_RELEASE_PATH');
    seen.add(file.path);
    const path = resolve(directory, file.path);
    if (!(await realpath(path)).startsWith(`${base}${sep}`) || !(await lstat(path)).isFile() || sha256(await readFile(path)) !== file.sha256) throw new Error('RELEASE_CHECKSUM_MISMATCH');
  }
  for (const required of ['infra/compose/compose.yaml','scripts/release.mjs','db/migrations/001_ticket_core.sql'])
    if (!seen.has(required)) throw new Error('INCOMPLETE_RELEASE');
  if (schemaFingerprint(manifest.files) !== manifest.schemaFingerprint) throw new Error('SCHEMA_FINGERPRINT_MISMATCH');
  for (const name of ['api','web','worker','postgres','redis']) {
    if (!new RegExp(`^ghcr\\.io/gomi95932/itsm-${name}@sha256:[a-f0-9]{64}$`).test(manifest.images?.[name] ?? '')) throw new Error('IMMUTABLE_IMAGE_DIGEST_REQUIRED');
  }
  return manifest;
}

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd:root, env:options.env ?? process.env, stdio:[options.input ?? 'ignore', options.output ?? 'pipe', 'pipe'] });
    let killTimer;
    const timer=setTimeout(() => { child.kill('SIGTERM'); killTimer=setTimeout(() => child.kill('SIGKILL'),5000); killTimer.unref(); },900000);
    timer.unref();
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    // Tool failures must not echo Compose configuration, database rows or credentials.
    child.stderr?.resume();
    child.once('error', () => { clearTimeout(timer); fail(new Error('RELEASE_TOOL_UNAVAILABLE')); });
    child.once('close', code => { clearTimeout(timer); clearTimeout(killTimer); code === 0 ? done(output.trim()) : fail(new Error('RELEASE_TOOL_FAILED')); });
  });
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
      if (!['env','state','backup'].includes(key) || !args[i+1] || args[i+1].startsWith('--') || options[key]) throw new Error('INVALID_RELEASE_ARGUMENT');
      options[key]=args[++i];
    } else positionals.push(args[i]);
  }
  if (!['check','deploy','backup','restore-check','rollback'].includes(command)
    || positionals.length !== (command === 'deploy' ? 1 : 0)
    || (options.backup && command !== 'restore-check')) throw new Error('INVALID_RELEASE_COMMAND');
  const envFile=resolve(options.env ?? '/opt/itsm/shared/development.env');
  const state=resolve(options.state ?? '/opt/itsm/shared/release-state');
  const envInfo=await lstat(envFile);
  if (!envInfo.isFile() || (envInfo.mode & 0o077) || ![0,process.getuid?.()].includes(envInfo.uid)) throw new Error('ENV_FILE_MUST_BE_PRIVATE_AND_OWNED');
  await mkdir(state,{ recursive:true,mode:0o700 });
  const stateInfo=await lstat(state);
  if (!stateInfo.isDirectory() || (stateInfo.mode & 0o077) || ![0,process.getuid?.()].includes(stateInfo.uid)) throw new Error('STATE_DIRECTORY_MUST_BE_PRIVATE');
  const lock=await open(resolve(state,'operation.lock'),'wx',0o600).catch(() => { throw new Error('RELEASE_OPERATION_ALREADY_LOCKED'); });
  let phase='preflight', backupPath;
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
    const existing=await optionalJson(currentPath);
    const backup=async () => {
      const directory=resolve(state,'backups'); await mkdir(directory,{recursive:true,mode:0o700});
      const path=resolve(directory,`itsm-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
      const file=await open(path,'wx',0o600);
      try { await compose(['exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U itsm -d itsm -Fc'],{output:file.fd}); await file.sync(); }
      finally { await file.close(); }
      const input=await open(path,'r');
      try { await compose(['exec','-T','db','pg_restore','--list'],{input:input.fd}); }
      finally { await input.close(); }
      await atomicJson(`${path}.json`,{file:path,sha256:sha256(await readFile(path)),createdAt:new Date().toISOString(),release:existing?.sha ?? null});
      return path;
    };
    const smoke=async () => {
      const base=`http://127.0.0.1:${port}`;
      const ready=await fetch(`${base}/api/v1/health/ready`,{signal:AbortSignal.timeout(10000)});
      if (!ready.ok || (await ready.json()).status !== 'ok') throw new Error('READINESS_CHECK_FAILED');
      const web=await fetch(base,{signal:AbortSignal.timeout(10000)});
      if (!web.ok || !(await web.text()).includes('id="app"')) throw new Error('WEB_SMOKE_FAILED');
    };
    if (command === 'check') { console.log('Docker, private configuration and loopback isolation checks passed'); return; }
    if (command === 'backup') { backupPath=await backup(); console.log(`Backup verified: ${backupPath}`); return; }
    if (command === 'restore-check') {
      if (!options.backup) throw new Error('BACKUP_PATH_REQUIRED');
      const path=resolve(options.backup), metadata=JSON.parse(await readFile(`${path}.json`,'utf8'));
      if (!(await lstat(path)).isFile() || sha256(await readFile(path)) !== metadata.sha256) throw new Error('BACKUP_CHECKSUM_MISMATCH');
      const database=`itsm_restore_${Date.now()}_${process.pid}`;
      const sql=(query,db='postgres') => compose(['exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d "$1" -Atc "$2"','sh',db,query]);
      await sql(`CREATE DATABASE ${database}`);
      try {
        const input=await open(path,'r');
        try { await compose(['exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec pg_restore --exit-on-error --no-owner --no-acl -U itsm -d "$1"','sh',database],{input:input.fd}); }
        finally { await input.close(); }
        await sql('SELECT count(*) FROM schema_migrations',database);
        await sql('SELECT count(*) FROM tickets',database);
        console.log('Backup restored and schema/ticket reads verified in an isolated temporary database');
      } finally { await sql(`DROP DATABASE ${database}`); }
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
      await smoke();
      await atomicJson(previousPath,existing);
      await atomicJson(currentPath,{...previous,images:{...previous.images,postgres:existing.images.postgres,redis:existing.images.redis},digests:{...previous.digests,postgres:existing.digests.postgres,redis:existing.digests.redis},verifiedAt:new Date().toISOString()});
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
    phase='smoke'; await smoke();
    const images={...manifest.images};
    const digests={};
    for (const [name,image] of Object.entries(images)) digests[name]=JSON.parse(await run('docker',['image','inspect',image,'--format','{{json .RepoDigests}}']));
    const record={sha:manifest.sha,bundlePath:root,schemaFingerprint:manifest.schemaFingerprint,images,digests,backup:backupPath,verifiedAt:new Date().toISOString()};
    await atomicJson(resolve(state,`release-${Date.now()}-${manifest.sha}.json`),record);
    if (existing) await atomicJson(previousPath,existing);
    await atomicJson(currentPath,record);
    console.log(`Development deployment verified: ${manifest.sha}`);
  } catch (error) {
    await atomicJson(resolve(state,`failure-${Date.now()}.json`),{phase,backup:backupPath ?? null,at:new Date().toISOString()}).catch(() => {});
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
