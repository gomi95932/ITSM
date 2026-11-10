import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { schemaFingerprint, validateConfig, validateRelease } from '../../scripts/release.mjs';

const config=() => ({name:'itsm-dev',services:{web:{ports:[{host_ip:'127.0.0.1',published:'8088'}]},db:{environment:{POSTGRES_PASSWORD:'a'.repeat(64)}},redis:{environment:{ITSM_REDIS_PASSWORD:'b'.repeat(64)}},api:{},worker:{},migrate:{environment:{NODE_ENV:'development',ITSM_SEED_DEV_DATA:'false'}}}});
test('release validation requires private isolated development services',() => {
  assert.equal(validateConfig(config()),8088);
  const exposed=config(); exposed.services.db.ports=[{published:'5432'}]; assert.throws(() => validateConfig(exposed),/INTERNAL_SERVICE/);
  const publicWeb=config(); publicWeb.services.web.ports[0].host_ip='0.0.0.0'; assert.throws(() => validateConfig(publicWeb),/LOOPBACK/);
  const example=config(); example.services.db.environment.POSTGRES_PASSWORD='replace-with-random-test-password'; assert.throws(() => validateConfig(example),/CREDENTIALS/);
  const production=config(); production.services.migrate.environment={NODE_ENV:'production',ITSM_SEED_DEV_DATA:'true'}; assert.throws(() => validateConfig(production),/SEED_FORBIDDEN/);
});
test('bundle verifies exact SHA, file contents and migration fingerprint',async () => {
  const directory=await mkdtemp(resolve(tmpdir(),'itsm-release-'));
  try {
    const files=[];
    for (const path of ['infra/compose/compose.yaml','scripts/release.mjs','db/migrations/001_ticket_core.sql']) {
      await mkdir(resolve(directory,path,'..'),{recursive:true}); await writeFile(resolve(directory,path),'fixture');
      files.push({path,sha256:createHash('sha256').update(await readFile(resolve(directory,path))).digest('hex')});
    }
    const images=Object.fromEntries(['api','web','worker','postgres','redis'].map(name=>[name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'b'.repeat(64)}`]));
    const sha='a'.repeat(40), manifest={sha,repository:'gomi95932/ITSM',ref:'refs/heads/main',files,schemaFingerprint:schemaFingerprint(files),images};
    await writeFile(resolve(directory,'release.json'),JSON.stringify(manifest));
    assert.equal((await validateRelease(directory,sha)).sha,sha);
    await assert.rejects(validateRelease(directory,'b'.repeat(40)),/UNAPPROVED/);
    manifest.images.api='ghcr.io/gomi95932/itsm-api:latest';
    await writeFile(resolve(directory,'release.json'),JSON.stringify(manifest));
    await assert.rejects(validateRelease(directory,sha),/IMMUTABLE/);
    manifest.images.api=`ghcr.io/gomi95932/itsm-api@sha256:${'b'.repeat(64)}`;
    await writeFile(resolve(directory,'release.json'),JSON.stringify(manifest));
    await writeFile(resolve(directory,files[0].path),'tampered');
    await assert.rejects(validateRelease(directory,sha),/CHECKSUM/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
