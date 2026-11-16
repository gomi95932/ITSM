import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const directory=await mkdtemp(resolve(tmpdir(),'itsm-recovery-ci-'));
const envFile=process.env.ITSM_CI_ENV;
const prefix=['compose','--project-name','itsm-dev','--env-file',envFile,'-f','infra/compose/compose.yaml'];
async function run(command,args,{success=true}={}) {
  return new Promise((done,fail) => {
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
    let text=''; child.stdout.on('data',chunk=>{text+=chunk;}); child.stderr.resume();
    child.once('error',fail);
    child.once('close',code=>{if(success && code!==0) fail(new Error('CI_RECOVERY_COMMAND_FAILED')); else done({code,text:text.trim()});});
  });
}
const compose=(args,options)=>run('docker',[...prefix,...args],options);
const sql=async query=>(await compose(['exec','-T','db','sh','-ec','PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query])).text;
try {
  const before=await sql('SELECT json_agg(s ORDER BY name) FROM schema_migrations s');
  assert.equal(JSON.parse(before).length,14);
  await compose(['run','--rm','--no-deps','migrate']);
  assert.equal(await sql('SELECT json_agg(s ORDER BY name) FROM schema_migrations s'),before,'repeated migrations must preserve the ledger');
  const first=JSON.parse(before)[0];
  await sql(`UPDATE schema_migrations SET checksum='invalid' WHERE name='${first.name}'`);
  try {
    const mismatch=await compose(['run','--rm','--no-deps','migrate'],{success:false});
    assert.notEqual(mismatch.code,0,'changed applied migrations must fail');
  } finally { await sql(`UPDATE schema_migrations SET checksum='${first.checksum}' WHERE name='${first.name}'`); }
  const migrations=resolve(directory,'migrations');
  const { mkdir }=await import('node:fs/promises'); await mkdir(migrations);
  for (const file of await readdir('db/migrations')) await copyFile(resolve('db/migrations',file),resolve(migrations,file));
  await writeFile(resolve(migrations,'999_atomic_failure.sql'),'CREATE TABLE migration_atomic_probe(id integer); SELECT 1/0;');
  const failed=await compose(['run','--rm','--no-deps','-v',`${migrations}:/srv/db/migrations:ro`,'migrate'],{success:false});
  assert.notEqual(failed.code,0,'invalid migration must fail');
  assert.equal(await sql("SELECT to_regclass('public.migration_atomic_probe') IS NULL"),'t','failed migration must roll back DDL');
  assert.equal(await sql('SELECT json_agg(s ORDER BY name) FROM schema_migrations s'),before);

  const state=resolve(directory,'state'), tickets=await sql('SELECT count(*) FROM tickets');
  await run('node',['scripts/release.mjs','check','--env',envFile,'--state',state]);
  await run('node',['scripts/release.mjs','backup','--env',envFile,'--state',state]);
  const backupName=(await readdir(resolve(state,'backups'))).find(name=>name.endsWith('.dump'));
  assert.ok(backupName);
  const backup=resolve(state,'backups',backupName);
  await run('node',['scripts/release.mjs','restore-check','--env',envFile,'--state',state,'--backup',backup]);
  assert.equal(await sql('SELECT count(*) FROM tickets'),tickets,'restore check must not change the live fixture database');
  assert.equal(await sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'itsm_restore_%'"),'0','temporary restore database must be removed');
  const metadata=JSON.parse(await readFile(`${backup}.json`,'utf8'));
  metadata.sha256='0'.repeat(64); await writeFile(`${backup}.json`,JSON.stringify(metadata));
  const corrupt=await run('node',['scripts/release.mjs','restore-check','--env',envFile,'--state',state,'--backup',backup],{success:false});
  assert.notEqual(corrupt.code,0,'corrupt backup must be rejected');
  console.log('Migration immutability, transaction rollback, backup recovery and live data isolation verified');
} finally { await rm(directory,{recursive:true,force:true}); }
