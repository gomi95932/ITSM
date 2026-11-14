import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { main, requiredReleaseFiles, schemaFingerprint, validateBusinessAcceptanceConfig, validateConfig, validateRelease, validateRuntimeContainer } from '../../scripts/release.mjs';

test('release business checks require seeded development identities and fake-only notifications', () => {
  const config=() => ({services:{api:{environment:{NODE_ENV:'development',ENABLE_DEV_AUTH:'true',NOTIFICATION_MODE:'fake'}},
    migrate:{environment:{ITSM_SEED_DEV_DATA:'true'}},worker:{environment:{NOTIFICATION_MODE:'fake',ENABLE_LIVE_NOTIFICATIONS:'false'}}}});
  assert.doesNotThrow(() => validateBusinessAcceptanceConfig(config()));
  for (const [service,key,value] of [['api','NODE_ENV','production'],['api','ENABLE_DEV_AUTH','false'],
    ['api','NOTIFICATION_MODE','dingtalk'],['migrate','ITSM_SEED_DEV_DATA','false'],
    ['worker','NOTIFICATION_MODE','dingtalk'],['worker','ENABLE_LIVE_NOTIFICATIONS','true']]) {
    const changed=config(); changed.services[service].environment[key]=value;
    assert.throws(() => validateBusinessAcceptanceConfig(changed),/ISOLATED_SYNTHETIC_ACCEPTANCE/);
    delete changed.services[service].environment[key];
    assert.throws(() => validateBusinessAcceptanceConfig(changed),/ISOLATED_SYNTHETIC_ACCEPTANCE/);
  }
});

test('release accepts synthetic write approval only for deploy and rollback', async () => {
  for (const command of ['check','backup','restore-check'])
    await assert.rejects(main([command,'--verify-development']),/INVALID_RELEASE_COMMAND/);
  await assert.rejects(main(['deploy','a'.repeat(40),'--verify-development','--verify-development']),/INVALID_RELEASE_ARGUMENT/);
});

test('runtime verification requires approved image, project, service and healthy state',() => {
  const image=`sha256:${'c'.repeat(64)}`;
  const container=() => ({Image:image,Config:{Labels:{'com.docker.compose.project':'itsm-dev',
    'com.docker.compose.service':'api','com.docker.compose.oneoff':'False'}},State:{Running:true,Health:{Status:'healthy'}}});
  assert.doesNotThrow(() => validateRuntimeContainer(container(),image,'api'));
  assert.throws(() => validateRuntimeContainer(container(),`sha256:${'d'.repeat(64)}`,'api'),/IMAGE_MISMATCH/);
  assert.throws(() => validateRuntimeContainer(container(),'itsm-api:latest','api'),/IMAGE_MISMATCH/);
  assert.throws(() => validateRuntimeContainer(container(),image,'worker'),/SCOPE_MISMATCH/);
  const foreign=container(); foreign.Config.Labels['com.docker.compose.project']='other';
  assert.throws(() => validateRuntimeContainer(foreign,image,'api'),/SCOPE_MISMATCH/);
  const oneoff=container(); oneoff.Config.Labels['com.docker.compose.oneoff']='True';
  assert.throws(() => validateRuntimeContainer(oneoff,image,'api'),/SCOPE_MISMATCH/);
  const stopped=container(); stopped.State.Running=false;
  assert.throws(() => validateRuntimeContainer(stopped,image,'api'),/NOT_HEALTHY/);
  const unhealthy=container(); unhealthy.State.Health.Status='unhealthy';
  assert.throws(() => validateRuntimeContainer(unhealthy,image,'api'),/NOT_HEALTHY/);
  const noHealth=container(); delete noHealth.State.Health;
  assert.throws(() => validateRuntimeContainer(noHealth,image,'api'),/NOT_HEALTHY/);
});

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
    for (const path of requiredReleaseFiles) {
      await mkdir(resolve(directory,path,'..'),{recursive:true}); await writeFile(resolve(directory,path),'fixture');
      files.push({path,sha256:createHash('sha256').update(await readFile(resolve(directory,path))).digest('hex')});
    }
    const images=Object.fromEntries(['api','web','worker','postgres','redis'].map(name=>[name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'b'.repeat(64)}`]));
    const sha='a'.repeat(40), manifest={sha,repository:'gomi95932/ITSM',ref:'refs/heads/main',files,schemaFingerprint:schemaFingerprint(files),images};
    await writeFile(resolve(directory,'release.json'),JSON.stringify(manifest));
    assert.equal((await validateRelease(directory,sha)).sha,sha);
    await assert.rejects(validateRelease(directory,sha,{requireBusinessAcceptance:true}),/HASHED_BUSINESS_ACCEPTANCE_TOOL_REQUIRED/);
    for (const required of requiredReleaseFiles) {
      const incomplete=files.filter(file => file.path !== required);
      await writeFile(resolve(directory,'release.json'),JSON.stringify({...manifest,files:incomplete,schemaFingerprint:schemaFingerprint(incomplete)}));
      await assert.rejects(validateRelease(directory,sha),/INCOMPLETE_RELEASE/);
    }
    await writeFile(resolve(directory,'release.json'),JSON.stringify(manifest));
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

test('business acceptance tool must be covered by the verified release manifest', async () => {
  const directory=await mkdtemp(resolve(tmpdir(),'itsm-release-business-'));
  try {
    const files=[];
    for (const path of [...requiredReleaseFiles,'scripts/verify-development.mjs']) {
      await mkdir(resolve(directory,path,'..'),{recursive:true}); await writeFile(resolve(directory,path),'fixture');
      files.push({path,sha256:createHash('sha256').update('fixture').digest('hex')});
    }
    const sha='a'.repeat(40),images=Object.fromEntries(['api','web','worker','postgres','redis']
      .map(name=>[name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'b'.repeat(64)}`]));
    await writeFile(resolve(directory,'release.json'),JSON.stringify({sha,repository:'gomi95932/ITSM',
      ref:'refs/heads/main',files,schemaFingerprint:schemaFingerprint(files),images}));
    assert.equal((await validateRelease(directory,sha,{requireBusinessAcceptance:true})).sha,sha);
    await writeFile(resolve(directory,'scripts/verify-development.mjs'),'tampered');
    await assert.rejects(validateRelease(directory,sha,{requireBusinessAcceptance:true}),/RELEASE_CHECKSUM_MISMATCH/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
