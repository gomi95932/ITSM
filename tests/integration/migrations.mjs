import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inventoryFingerprint, recoveryMethod, validateRecoveryProof } from '../../scripts/release.mjs';

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
const literal=value=>`'${String(value).replaceAll("'","''")}'`;
async function readiness(expected) {
  const response=await fetch('http://127.0.0.1:8088/api/v1/health/ready',{signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,expected ? 200 : 503,'readiness must reflect the complete image migration ledger');
  assert.deepEqual(await response.json(),expected ? {status:'ok',service:'itsm-api'} : {code:'API_NOT_READY'});
  const live=await fetch('http://127.0.0.1:8088/api/v1/health',{signal:AbortSignal.timeout(10000)});
  assert.equal(live.status,200,'schema mismatch must not be confused with process liveness');
}
try {
  const before=await sql('SELECT json_agg(s ORDER BY name) FROM schema_migrations s');
  const ledger=JSON.parse(before);
  const migrationFiles=(await readdir('db/migrations')).filter(file=>/^\d+_.*\.sql$/.test(file));
  assert.equal(ledger.length,migrationFiles.length);
  await readiness(true);
  for (const row of ledger.slice(-2)) {
    await sql(`DELETE FROM schema_migrations WHERE name=${literal(row.name)}`);
    try { await readiness(false); }
    finally {
      await sql(`INSERT INTO schema_migrations(name,checksum,applied_at) VALUES (${literal(row.name)},${literal(row.checksum)},${literal(row.applied_at)})`);
    }
    await readiness(true);
  }
  await sql("INSERT INTO schema_migrations(name,checksum) VALUES ('999_readiness_probe.sql',repeat('f',64))");
  try { await readiness(false); }
  finally { await sql("DELETE FROM schema_migrations WHERE name='999_readiness_probe.sql'"); }
  await readiness(true);
  await compose(['run','--rm','--no-deps','migrate']);
  assert.equal(await sql('SELECT json_agg(s ORDER BY name) FROM schema_migrations s'),before,'repeated migrations must preserve the ledger');
  const first=ledger[0];
  await sql(`UPDATE schema_migrations SET checksum='invalid' WHERE name='${first.name}'`);
  try {
    await readiness(false);
    const mismatch=await compose(['run','--rm','--no-deps','migrate'],{success:false});
    assert.notEqual(mismatch.code,0,'changed applied migrations must fail');
  } finally { await sql(`UPDATE schema_migrations SET checksum='${first.checksum}' WHERE name='${first.name}'`); }
  await readiness(true);
  const migrations=resolve(directory,'migrations');
  const { mkdir }=await import('node:fs/promises'); await mkdir(migrations);
  for (const file of await readdir('db/migrations')) await copyFile(resolve('db/migrations',file),resolve(migrations,file));
  await writeFile(resolve(migrations,'999_atomic_failure.sql'),'CREATE TABLE migration_atomic_probe(id integer); SELECT 1/0;');
  const failed=await compose(['run','--rm','--no-deps','-v',`${migrations}:/srv/db/migrations:ro`,'migrate'],{success:false});
  assert.notEqual(failed.code,0,'invalid migration must fail');
  assert.equal(await sql("SELECT to_regclass('public.migration_atomic_probe') IS NULL"),'t','failed migration must roll back DDL');
  assert.equal(await sql('SELECT json_agg(s ORDER BY name) FROM schema_migrations s'),before);

  const state=resolve(directory,'state'), tickets=await sql('SELECT count(*) FROM tickets');
  await sql(`CREATE TABLE recovery_evidence_probe(id integer,payload text,recorded_at timestamptz,bytes bytea);
    INSERT INTO recovery_evidence_probe SELECT n%2050,'recovery-'||(n%2050),
      '2026-11-01T08:00:00+08'::timestamptz,decode('00ff','hex') FROM generate_series(1,4100) n;`);
  await run('node',['scripts/release.mjs','check','--env',envFile,'--state',state]);
  let writing=true,writes=0,writerError;
  const writer=(async () => {
    while (writing) {
      await sql(`INSERT INTO recovery_evidence_probe VALUES (${10000+writes},'during-backup',now(),NULL)`);
      writes++;
    }
  })().catch(error => { writerError=error; writing=false; });
  // Exercise the inventory/dump snapshot binding while source data continues to change.
  try { await run('node',['scripts/release.mjs','backup','--env',envFile,'--state',state]); }
  finally { writing=false; await writer; }
  if (writerError) throw writerError;
  assert.ok(writes > 0,'recovery fixture must actually write during backup');
  const backupName=(await readdir(resolve(state,'backups'))).find(name=>name.endsWith('.dump'));
  assert.ok(backupName);
  const backup=resolve(state,'backups',backupName);
  const metadata=JSON.parse(await readFile(`${backup}.json`,'utf8'));
  for (const table of ['schema_migrations','tickets','audit_logs','service_catalog','recovery_evidence_probe'])
    assert.ok(metadata.inventory.some(row=>row.table===table),`recovery evidence must cover ${table}`);
  const probeRows=BigInt(metadata.inventory.find(row=>row.table==='recovery_evidence_probe').rows);
  assert.ok(probeRows >= 4100n && probeRows <= BigInt(4100+writes));
  const restoreArgs=['scripts/release.mjs','restore-check','--env',envFile,'--state',state,'--backup',backup];
  // A later legitimate write must not be compared with an earlier backup snapshot.
  await sql("INSERT INTO recovery_evidence_probe VALUES (9000,'after-backup',now(),NULL)");
  await run('node',restoreArgs);
  const proof=JSON.parse(await readFile(`${backup}.restore.json`,'utf8'));
  assert.equal(proof.method,recoveryMethod);
  validateRecoveryProof(metadata,proof);
  assert.equal(proof.attachments?.method,'isolated-attachment-bytes-v1');
  assert.ok(proof.attachments.referenced>0,'recovery must verify real attachment bytes from the preceding HTTP fixture');
  const attachmentArchive=await readFile(metadata.attachments.file,'utf8');
  const records=attachmentArchive.trimEnd().split('\n').map(line=>JSON.parse(line));
  for(const kind of ['missing-attachment','changed-attachment','archive-checksum']){
    await writeFile(`${backup}.json`,JSON.stringify(metadata));
    await writeFile(metadata.attachments.file,attachmentArchive);
    await run('node',restoreArgs);
    const changed=structuredClone(records),changedMetadata=structuredClone(metadata);
    if(kind==='missing-attachment'){
      const requiredId=await sql("SELECT id FROM attachments WHERE scan_status='CLEAN' ORDER BY id LIMIT 1");
      const index=changed.findIndex(item=>item.key===`${requiredId}.blob`);assert.ok(index>0);changed.splice(index,1);
      const objects=changed.slice(1,-1).map(({key,size,sha256})=>({key,size,sha256})).sort((a,b)=>a.key.localeCompare(b.key));
      changed[changed.length-1]={complete:true,objects:objects.length,inventorySha256:createHash('sha256').update(JSON.stringify(objects)).digest('hex')};
    }else changed[1].bytes=Buffer.from('corrupted archive content').toString('base64');
    const corruptArchive=changed.map(item=>JSON.stringify(item)).join('\n')+'\n';
    await writeFile(metadata.attachments.file,corruptArchive);
    if(kind!=='archive-checksum')changedMetadata.attachments.sha256=createHash('sha256').update(corruptArchive).digest('hex');
    await writeFile(`${backup}.json`,JSON.stringify(changedMetadata));
    assert.notEqual((await run('node',restoreArgs,{success:false})).code,0,`${kind} must fail recovery`);
    await assert.rejects(readFile(`${backup}.restore.json`),{code:'ENOENT'});
    assert.equal(await sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'itsm_restore_%'"),'0');
  }
  await writeFile(`${backup}.json`,JSON.stringify(metadata));
  await writeFile(metadata.attachments.file,attachmentArchive);
  assert.equal(await sql('SELECT count(*) FROM recovery_evidence_probe'),String(4101+writes));
  for (const kind of ['missing-row','changed-content','missing-table']) {
    // Seed a real passed result before each failed recheck; no stale proof may survive.
    await writeFile(`${backup}.json`,JSON.stringify(metadata));
    await run('node',restoreArgs);
    validateRecoveryProof(metadata,JSON.parse(await readFile(`${backup}.restore.json`,'utf8')));
    const changed=structuredClone(metadata);
    const row=changed.inventory.find(row=>row.table==='recovery_evidence_probe');
    if (kind === 'missing-row') row.rows=String(BigInt(row.rows)-1n);
    if (kind === 'changed-content') row.sha256='0'.repeat(64);
    if (kind === 'missing-table') changed.inventory=changed.inventory.filter(item=>item.table!==row.table);
    changed.inventorySha256=inventoryFingerprint(changed.inventory);
    await writeFile(`${backup}.json`,JSON.stringify(changed));
    const mismatch=await run('node',restoreArgs,{success:false});
    assert.notEqual(mismatch.code,0,`${kind} must fail even with a valid archive checksum`);
    await assert.rejects(readFile(`${backup}.restore.json`),{code:'ENOENT'},
      `${kind} must invalidate the previous passed recovery proof`);
    assert.equal(await sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'itsm_restore_%'"),'0');
  }
  await writeFile(`${backup}.json`,JSON.stringify(metadata));
  await run('node',restoreArgs);
  validateRecoveryProof(metadata,JSON.parse(await readFile(`${backup}.restore.json`,'utf8')));
  assert.equal(await sql('SELECT count(*) FROM tickets'),tickets,'restore check must not change the live fixture database');
  assert.equal(await sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'itsm_restore_%'"),'0','temporary restore database must be removed');
  metadata.sha256='0'.repeat(64); await writeFile(`${backup}.json`,JSON.stringify(metadata));
  const corrupt=await run('node',['scripts/release.mjs','restore-check','--env',envFile,'--state',state,'--backup',backup],{success:false});
  assert.notEqual(corrupt.code,0,'corrupt backup must be rejected');
  await assert.rejects(readFile(`${backup}.restore.json`),{code:'ENOENT'},
    'archive checksum failure must also invalidate the previous passed recovery proof');
  console.log('Image-bound schema readiness, migration immutability, transaction rollback, backup recovery and live data isolation verified');
} finally {
  await sql('DROP TABLE IF EXISTS recovery_evidence_probe');
  await rm(directory,{recursive:true,force:true});
}
