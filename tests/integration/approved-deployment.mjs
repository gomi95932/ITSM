import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { inventoryFingerprint, recoveryMethod, requiredReleaseFiles, schemaFingerprint } from '../../scripts/release.mjs';
import { enterpriseEvidence } from '../fixtures/enterprise-uat.mjs';

assert.equal(process.getuid(),0,'Only run in disposable Linux CI with sudo, never on the Mac or development server');
const checkout=fileURLToPath(new URL('../../',import.meta.url));
const sha='a'.repeat(40),baseline='e'.repeat(40),requestId='d'.repeat(32);
const instant=Date.parse('2026-11-15T03:00:00Z');
const files=['execute-approved-deployment.mjs','promote-release.mjs','stage-release.mjs',
  'release.mjs','verify-release-source.mjs','extract-release.py'];
const digest=value => createHash('sha256').update(value).digest('hex');

async function fixture(t,{enterprise=false}={}) {
  const root=await mkdtemp('/run/itsm-deployment-test-');
  t.after(() => rm(root,{recursive:true,force:true}));
  const paths={tools:join(root,'tools'),releases:join(root,'releases'),approvals:join(root,'approvals'),
    executions:join(root,'executions'),state:join(root,'state'),env:join(root,'development.env'),token:join(root,'read.token')};
  for (const name of ['tools','releases','approvals','executions','state']) await mkdir(paths[name],{mode:0o700});
  for (const name of files) {
    const target=join(paths.tools,name);
    await copyFile(join(checkout,'scripts',name),target);
    await chown(target,0,0);
    await chmod(target,0o600);
  }
  await writeFile(paths.token,'fixture-read-identity\n',{mode:0o600});
  await writeFile(paths.env,'SYNTHETIC_FIXTURE_ONLY=true\n',{mode:0o600});
  const approval={version:1,repository:'gomi95932/ITSM',ref:'refs/heads/main',sha,runId:123,runAttempt:2,
    artifactId:456,artifactDigest:`sha256:${'b'.repeat(64)}`,artifactSize:100,approvedBy:'reviewer',
    approvalRef:'change/CHG-001',approvedAt:'2026-11-15T02:00:00Z',expiresAt:'2026-11-15T04:00:00Z',
    requestId,operation:'deploy-development',verifyDevelopment:true,expectedCurrentSha:baseline};
  if(enterprise)Object.assign(approval,{operation:'deploy-enterprise-uat',verifyDevelopment:false,verifyEnterpriseUat:true,
    configurationSha256:digest(await readFile(paths.env))});
  const approvalPath=join(paths.approvals,`${requestId}.json`);
  await writeFile(approvalPath,JSON.stringify(approval),{mode:0o600});
  const bundle=join(paths.releases,sha),manifestFiles=[];
  for (const path of [...requiredReleaseFiles,'scripts/verify-development.mjs','scripts/verify-enterprise-uat.mjs']) {
    const target=join(bundle,path),content=`fixture ${path}`;
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,content,{mode:0o600});
    manifestFiles.push({path,sha256:digest(content)});
  }
  const images=Object.fromEntries(['api','web','worker','postgres','redis'].map(name =>
    [name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'c'.repeat(64)}`]));
  const manifest={repository:approval.repository,ref:approval.ref,sha,runId:'123',runAttempt:2,
    images,files:manifestFiles,schemaFingerprint:schemaFingerprint(manifestFiles),recoveryVerification:recoveryMethod};
  await writeFile(join(bundle,'release.json'),JSON.stringify(manifest),{mode:0o600});
  const promotionPath=join(paths.releases,`${sha}.promotion.json`);
  const promotion={...approval,bundlePath:bundle,images,schemaFingerprint:manifest.schemaFingerprint,
    verificationLevel:'approved-root-promoted',deploymentPerformed:false};
  await writeFile(promotionPath,JSON.stringify(promotion),{mode:0o600});
  const statePath=join(paths.state,'current.json'),receiptPath=join(paths.executions,`${requestId}.json`);
  await writeFile(statePath,JSON.stringify({sha:baseline}),{mode:0o600});
  const helpers=await import(pathToFileURL(join(paths.tools,'execute-approved-deployment.mjs')));
  const source={...approval,verificationLevel:'github-source-only'},calls=[];
  let clock=instant,queries=0;
  const dependencies={paths,now:() => clock,checkRuntime:false,
    verifySource:async selection => {
      queries++;
      assert.deepEqual(selection,{sha,runId:123,token:'fixture-read-identity'});
      return {...source};
    },
    // These fixtures prove orchestration boundaries, not Docker or real business readiness.
    execute:async (directory,args) => {
      assert.equal(directory,bundle);
      calls.push(args);
      if (args[0] === 'deploy') {
        assert.deepEqual(args,['deploy',sha,enterprise?'--verify-enterprise-uat':'--verify-development']);
        await writeFile(statePath,JSON.stringify({sha,images,verificationLevel:enterprise?'enterprise-uat-readiness':'synthetic-business',
          businessAcceptance:enterprise?null:{status:'passed',checks:['fixture-only']},
          ...(enterprise?{enterpriseReadiness:enterpriseEvidence(approval.configurationSha256,new Date(clock).toISOString())}:{})}),{mode:0o600});
        return `Development deployment verified: ${sha}`;
      }
      if (args[0] === 'backup') {
        assert.deepEqual(args,['backup']);
        const directory=join(paths.state,'backups'); await mkdir(directory,{mode:0o700});
        const backup=join(directory,'itsm-2026-11-15T03-00-00-000Z.dump'),data='fixture backup';
        await writeFile(backup,data,{mode:0o600});
        await writeFile(`${backup}.json`,JSON.stringify({file:backup,release:sha,sha256:digest(data),
          inventoryMethod:'public-table-chunked-sha256-v1',inventory:[],inventorySha256:inventoryFingerprint([])}),{mode:0o600});
        return `Backup verified: ${backup}`;
      }
      assert.deepEqual(args,['restore-check','--backup',join(paths.state,'backups','itsm-2026-11-15T03-00-00-000Z.dump')]);
      const metadata=JSON.parse(await readFile(`${args[2]}.json`,'utf8'));
      await writeFile(`${args[2]}.restore.json`,JSON.stringify({method:recoveryMethod,status:'passed',
        backupSha256:metadata.sha256,inventorySha256:metadata.inventorySha256,tableCount:0,
        verifiedAt:new Date(clock).toISOString()}),{mode:0o600});
      return 'fixture isolated recovery completed';
    },
  };
  return {root,paths,bundle,manifest,approval,approvalPath,promotion,promotionPath,statePath,receiptPath,
    helpers,source,calls,dependencies,queries:() => queries,setClock:value => { clock=value; }};
}

test('runs only deploy, backup and isolated recovery after exact approval and provenance',async t => {
  const f=await fixture(t);
  const receipt=await f.helpers.executeApprovedDeployment(requestId,f.dependencies);
  assert.equal(receipt.status,'succeeded');
  assert.equal(receipt.phase,'complete');
  assert.equal(receipt.expectedCurrentSha,baseline);
  assert.equal(receipt.restoreCheck,recoveryMethod);
  assert.equal(receipt.recoveryEvidence.inventorySha256,inventoryFingerprint([]));
  assert.deepEqual(receipt.images,f.manifest.images);
  assert.equal(f.queries(),1);
  assert.deepEqual(f.calls.map(args => args[0]),['deploy','backup','restore-check']);
  const proof=await readFile(f.receiptPath,'utf8');
  assert.equal(JSON.parse(proof).artifactId,456);
  assert.equal(proof.includes('fixture-read-identity'),false);
  assert.equal((await lstat(f.receiptPath)).mode & 0o777,0o600);
  assert.deepEqual(await readdir(f.paths.executions),[`${requestId}.json`]);
  await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/DEPLOYMENT_BASELINE_CHANGED/);
  assert.equal(await readFile(f.receiptPath,'utf8'),proof);
  assert.equal(f.calls.length,3);
});

test('enterprise deployment preserves backup recovery and records readiness without synthetic transactions or user acceptance',async t=>{
  const f=await fixture(t,{enterprise:true});
  const receipt=await f.helpers.executeApprovedDeployment(requestId,f.dependencies);
  assert.equal(receipt.status,'succeeded');assert.equal(receipt.operation,'deploy-enterprise-uat');
  assert.equal(receipt.configurationSha256,f.approval.configurationSha256);assert.equal(receipt.businessAcceptance,null);
  assert.equal(receipt.userAcceptance,'pending');assert.equal(receipt.enterpriseReadiness.status,'passed');
  assert.equal(receipt.restoreCheck,recoveryMethod);
  assert.deepEqual(f.calls.map(args=>args[0]),['deploy','backup','restore-check']);
});

test('enterprise configuration changes before, during provenance, or after deployment cannot succeed',async t=>{
  for(const phase of ['before','source','deploy','restore-check']){
    const f=await fixture(t,{enterprise:true}),change=()=>writeFile(f.paths.env,'CHANGED=true\n',{mode:0o600});
    if(phase==='before')await change();
    else if(phase==='source'){
      const verify=f.dependencies.verifySource;
      f.dependencies.verifySource=async selection=>{const source=await verify(selection);await change();return source;};
    }else{
      const execute=f.dependencies.execute;
      f.dependencies.execute=async(bundle,args)=>{const result=await execute(bundle,args);if(args[0]===phase)await change();return result;};
    }
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/APPROVED_ENTERPRISE_CONFIGURATION_MISMATCH/);
    if(['before','source'].includes(phase))assert.equal(f.calls.length,0);
    else assert.equal(JSON.parse(await readFile(f.receiptPath,'utf8')).status,'failed');
  }
});

test('enterprise deployment rejects stale, incomplete, mismatched or synthetic acceptance evidence',async t=>{
  for(const kind of ['stale','future','missing','configuration','synthetic']){
    const f=await fixture(t,{enterprise:true}),execute=f.dependencies.execute;
    f.dependencies.execute=async(bundle,args)=>{
      const result=await execute(bundle,args);
      if(args[0]==='deploy'){
        const current=JSON.parse(await readFile(f.statePath,'utf8'));
        if(kind==='stale')current.enterpriseReadiness.completedAt='2026-11-14T03:00:00Z';
        if(kind==='future')current.enterpriseReadiness.completedAt='2026-11-16T03:00:00Z';
        if(kind==='missing')delete current.enterpriseReadiness;
        if(kind==='configuration')current.enterpriseReadiness.configurationSha256='0'.repeat(64);
        if(kind==='synthetic')current.businessAcceptance={status:'passed'};
        await writeFile(f.statePath,JSON.stringify(current),{mode:0o600});
      }
      return result;
    };
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/ENTERPRISE_READINESS_EVIDENCE_REQUIRED/);
    assert.deepEqual(f.calls.map(args=>args[0]),['deploy']);
  }
});

test('an existing consumed receipt is never overwritten on replay even when baseline still matches',async t => {
  for (const status of ['succeeded','failed','running']) {
    const f=await fixture(t),proof=JSON.stringify({requestId,status,uniqueEvidence:'retain exactly'});
    await writeFile(f.receiptPath,proof,{mode:0o600});
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),{code:'EEXIST'});
    assert.equal(await readFile(f.receiptPath,'utf8'),proof);
    assert.deepEqual(f.calls,[]);
    assert.deepEqual(await readdir(f.paths.executions),[`${requestId}.json`]);
  }
});

test('rejects legacy recovery capability before deployment or receipt consumption',async t => {
  const f=await fixture(t),manifest={...f.manifest};
  delete manifest.recoveryVerification;
  await writeFile(join(f.bundle,'release.json'),JSON.stringify(manifest));
  await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/RELEASE_RECOVERY_CAPABILITY_REQUIRED/);
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(await readdir(f.paths.executions),[]);
});

test('refuses source drift, baseline changes and invalid read identity before application commands',async t => {
  for (const kind of ['source','baseline','empty-token','multiline-token']) {
    const f=await fixture(t);
    if (kind === 'source') f.source.runAttempt=3;
    if (kind === 'baseline') await writeFile(f.statePath,JSON.stringify({sha:'f'.repeat(40)}));
    if (kind === 'empty-token') await writeFile(f.paths.token,'\n');
    if (kind === 'multiline-token') await writeFile(f.paths.token,'first\nsecond');
    const error={source:/APPROVED_RELEASE_SOURCE_MISMATCH/,baseline:/DEPLOYMENT_BASELINE_CHANGED/,
      'empty-token':/GITHUB_READ_IDENTITY_REQUIRED/,'multiline-token':/GITHUB_READ_IDENTITY_REQUIRED/}[kind];
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),error);
    assert.deepEqual(f.calls,[]);
    assert.deepEqual(await readdir(f.paths.executions),[]);
  }
});

test('checks revocation, expiry and changed approval again after the network query',async t => {
  for (const kind of ['revoked','expired','changed']) {
    const f=await fixture(t),verify=f.dependencies.verifySource;
    f.dependencies.verifySource=async selection => {
      const result=await verify(selection);
      if (kind === 'revoked') await rm(f.approvalPath);
      if (kind === 'expired') f.setClock(Date.parse(f.approval.expiresAt));
      if (kind === 'changed') await writeFile(f.approvalPath,JSON.stringify({...f.approval,approvedBy:'other-reviewer'}));
      return result;
    };
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),
      {revoked:{code:'ENOENT'},expired:/CURRENT_EXACT_ROOT_APPROVAL_REQUIRED/,changed:/DEPLOYMENT_APPROVAL_CHANGED/}[kind]);
    assert.deepEqual(f.calls,[]);
    assert.deepEqual(await readdir(f.paths.executions),[]);
  }
});

test('rejects untrusted ancestors, private files, tools and promoted bundle paths',async t => {
  for (const kind of ['ancestor','approvals','state','env','tool','bundle-file','hardlink','symlink']) {
    const f=await fixture(t),target=join(f.bundle,'scripts/release.mjs');
    if (kind === 'ancestor') await chmod(f.root,0o720);
    if (kind === 'approvals') await chmod(f.paths.approvals,0o755);
    if (kind === 'state') await chmod(f.paths.state,0o755);
    if (kind === 'env') await chmod(f.paths.env,0o644);
    if (kind === 'tool') await chmod(join(f.paths.tools,'stage-release.mjs'),0o622);
    if (kind === 'bundle-file') await chmod(target,0o644);
    if (kind === 'hardlink') await link(target,join(f.root,'extra-link'));
    if (kind === 'symlink') {
      const saved=join(f.root,'original.mjs'); await copyFile(target,saved); await chmod(saved,0o600);
      await rm(target); await symlink(saved,target);
    }
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/TRUSTED_ROOT_PATH_REQUIRED/);
    assert.equal(f.queries(),0);
    assert.deepEqual(f.calls,[]);
  }
});

test('requires the promoted record, file checksums and exact tree to match the approved artifact',async t => {
  for (const kind of ['promotion','checksum','unlisted']) {
    const f=await fixture(t);
    if (kind === 'promotion') await writeFile(f.promotionPath,JSON.stringify({...f.promotion,artifactId:457}));
    if (kind === 'checksum') await writeFile(join(f.bundle,'scripts/release.mjs'),'changed');
    if (kind === 'unlisted') await writeFile(join(f.bundle,'unlisted.mjs'),'extra',{mode:0o600});
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),
      {promotion:/APPROVED_PROMOTION_BINDING_REQUIRED/,checksum:/RELEASE_CHECKSUM_MISMATCH/,unlisted:/RELEASE_TREE_MISMATCH/}[kind]);
    assert.equal(f.queries(),0);
    assert.deepEqual(f.calls,[]);
  }
});

test('preserves another operation lock without launching application code',async t => {
  const f=await fixture(t),lock=join(f.paths.executions,'operation.lock');
  await mkdir(lock,{mode:0o700});
  await writeFile(join(lock,'owner'),'another operation',{mode:0o600});
  await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),{code:'EEXIST'});
  assert.equal(await readFile(join(lock,'owner'),'utf8'),'another operation');
  assert.deepEqual(f.calls,[]);
});

test('records failed phase without attempting an automatic rollback',async t => {
  for (const phase of ['deploy','backup','restore-check']) {
    const f=await fixture(t),execute=f.dependencies.execute;
    f.dependencies.execute=async (bundle,args) => {
      if (args[0] === phase) {
        f.calls.push(args);
        throw new Error('SIMULATED_EXECUTION_FAILURE');
      }
      return execute(bundle,args);
    };
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/SIMULATED_EXECUTION_FAILURE/);
    const receipt=JSON.parse(await readFile(f.receiptPath,'utf8'));
    assert.equal(receipt.status,'failed');
    assert.equal(receipt.phase,phase);
    assert.equal(receipt.error,'SIMULATED_EXECUTION_FAILURE');
    assert.deepEqual(f.calls.map(args => args[0]),['deploy','backup','restore-check'].slice(0,
      ['deploy','backup','restore-check'].indexOf(phase)+1));
    assert.deepEqual(await readdir(f.paths.executions),[`${requestId}.json`]);
  }
});

test('does not accept readiness-only, wrong image or missing business evidence as deployment success',async t => {
  for (const kind of ['readiness','image','business']) {
    const f=await fixture(t),execute=f.dependencies.execute;
    f.dependencies.execute=async (bundle,args) => {
      const result=await execute(bundle,args);
      const current=JSON.parse(await readFile(f.statePath,'utf8'));
      if (kind === 'readiness') current.verificationLevel='readiness-only';
      if (kind === 'image') current.images.api=current.images.web;
      if (kind === 'business') delete current.businessAcceptance;
      await writeFile(f.statePath,JSON.stringify(current));
      return result;
    };
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/DEPLOYMENT_BUSINESS_EVIDENCE_REQUIRED/);
    assert.equal(JSON.parse(await readFile(f.receiptPath,'utf8')).status,'failed');
    assert.deepEqual(f.calls.map(args => args[0]),['deploy']);
  }
});

test('backup must be private, fixed-path and bound to the deployed release',async t => {
  for (const kind of ['path','release','permissions']) {
    const f=await fixture(t),execute=f.dependencies.execute;
    f.dependencies.execute=async (bundle,args) => {
      const result=await execute(bundle,args);
      if (args[0] !== 'backup') return result;
      if (kind === 'path') return 'Backup verified: /tmp/outside.dump';
      const backup=result.slice('Backup verified: '.length);
      if (kind === 'permissions') await chmod(backup,0o644);
      if (kind === 'release') {
        const metadata=JSON.parse(await readFile(`${backup}.json`,'utf8'));
        await writeFile(`${backup}.json`,JSON.stringify({...metadata,release:baseline}));
      }
      return result;
    };
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),
      kind === 'permissions' ? /TRUSTED_ROOT_PATH_REQUIRED/ : /FIXED_BACKUP_EVIDENCE_REQUIRED/);
    assert.equal(JSON.parse(await readFile(f.receiptPath,'utf8')).phase,'backup');
    assert.deepEqual(f.calls.map(args => args[0]),['deploy','backup']);
  }
});

test('successful restore commands still require fresh, bound data integrity evidence',async t => {
  for (const kind of ['missing','checksum','inventory','method','old']) {
    const f=await fixture(t),execute=f.dependencies.execute;
    f.dependencies.execute=async (bundle,args) => {
      const result=await execute(bundle,args);
      if (args[0] !== 'restore-check') return result;
      const path=`${args[2]}.restore.json`;
      if (kind === 'missing') { await rm(path); return result; }
      const proof=JSON.parse(await readFile(path,'utf8'));
      if (kind === 'checksum') proof.backupSha256='0'.repeat(64);
      if (kind === 'inventory') proof.inventorySha256='0'.repeat(64);
      if (kind === 'method') proof.method='isolated-schema-and-ticket-reads';
      if (kind === 'old') proof.verifiedAt='2020-01-01T00:00:00Z';
      await writeFile(path,JSON.stringify(proof));
      return result;
    };
    await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies));
    const receipt=JSON.parse(await readFile(f.receiptPath,'utf8'));
    assert.equal(receipt.status,'failed');
    assert.equal(receipt.phase,'restore-check');
  }
});

test('detects final release drift and supports only explicitly approved empty baseline',async t => {
  const f=await fixture(t),execute=f.dependencies.execute;
  f.dependencies.execute=async (bundle,args) => {
    const result=await execute(bundle,args);
    if (args[0] === 'restore-check') await writeFile(f.statePath,JSON.stringify({sha:baseline}));
    return result;
  };
  await assert.rejects(f.helpers.executeApprovedDeployment(requestId,f.dependencies),/DEPLOYMENT_BASELINE_CHANGED/);
  assert.equal(JSON.parse(await readFile(f.receiptPath,'utf8')).phase,'restore-check');
  const empty=await fixture(t);
  await rm(empty.statePath);
  await assert.rejects(empty.helpers.executeApprovedDeployment(requestId,empty.dependencies),/DEPLOYMENT_BASELINE_CHANGED/);
  await writeFile(empty.approvalPath,JSON.stringify({...empty.approval,expectedCurrentSha:null}));
  assert.equal((await empty.helpers.executeApprovedDeployment(requestId,empty.dependencies)).status,'succeeded');
});

test('CLI refuses a non-installed checkout and arbitrary additional options',async () => {
  for (const args of [[requestId],[requestId,'--env','/tmp/untrusted.env']]) {
    await assert.rejects(promisify(execFile)(process.execPath,[join(checkout,'scripts/execute-approved-deployment.mjs'),...args],
      {env:{PATH:'/usr/bin:/bin'},timeout:10000}),error => {
      assert.equal(error.code,1);
      assert.equal(error.stderr.trim(),'INSTALLED_FIXED_DEPLOYMENT_ENTRY_REQUIRED');
      return true;
    });
  }
});
