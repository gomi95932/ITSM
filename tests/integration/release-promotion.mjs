import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { requiredReleaseFiles, schemaFingerprint } from '../../scripts/release.mjs';

assert.equal(process.getuid(),0,'Run only in the disposable Linux CI runner with sudo, never on the Mac or development server');
const checkout=fileURLToPath(new URL('../../',import.meta.url));
const sha='a'.repeat(40),instant=Date.parse('2026-11-15T03:00:00Z');
const files=['promote-release.mjs','stage-release.mjs','release.mjs','verify-release-source.mjs','extract-release.py'];

async function fixture(t) {
  const root=await mkdtemp('/run/itsm-promotion-test-');
  t.after(() => rm(root,{recursive:true,force:true}));
  const paths={tools:join(root,'tools'),releases:join(root,'releases'),approvals:join(root,'approvals'),token:join(root,'read.token')};
  for (const name of ['tools','releases','approvals']) await mkdir(paths[name],{mode:0o700});
  for (const name of files) {
    await copyFile(join(checkout,'scripts',name),join(paths.tools,name));
    await chmod(join(paths.tools,name),0o600);
  }
  await writeFile(paths.token,'fixture-read-identity\n',{mode:0o600});
  const approval={version:1,repository:'gomi95932/ITSM',ref:'refs/heads/main',sha,runId:123,runAttempt:2,
    artifactId:456,artifactDigest:`sha256:${'b'.repeat(64)}`,artifactSize:100,approvedBy:'reviewer',
    approvalRef:'change/CHG-001',approvedAt:'2026-11-15T02:00:00Z',expiresAt:'2026-11-15T04:00:00Z'};
  const approvalPath=join(paths.approvals,`${sha}.json`);
  await writeFile(approvalPath,JSON.stringify(approval),{mode:0o600});
  const helpers=await import(pathToFileURL(join(paths.tools,'promote-release.mjs')));
  for (const name of files) {
    const path=join(paths.tools,name);
    try {
      await helpers.requireRootOwnedPath(path);
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
  const source={...approval,verificationLevel:'github-source-only'};
  let queries=0,downloads=0,extracts=0,clock=instant;
  const dependencies={paths,now:() => clock,
    verifySource:async () => { queries++; return {...source}; },
    download:async (_source,token,path) => {
      downloads++; assert.equal(token,'fixture-read-identity'); await writeFile(path,'archive fixture',{mode:0o600});
    },
    extract:async (_archive,target) => {
      extracts++;
      const bundle=join(target,'bundle'); await mkdir(bundle,{recursive:true,mode:0o700});
      const manifestFiles=[];
      for (const path of [...requiredReleaseFiles,'scripts/verify-development.mjs']) {
        const content=`fixture ${path}`;
        await mkdir(dirname(join(bundle,path)),{recursive:true,mode:0o700});
        await writeFile(join(bundle,path),content,{mode:0o600});
        manifestFiles.push({path,sha256:createHash('sha256').update(content).digest('hex')});
      }
      const images=Object.fromEntries(['api','web','worker','postgres','redis'].map(name =>
        [name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'c'.repeat(64)}`]));
      await writeFile(join(bundle,'release.json'),JSON.stringify({repository:approval.repository,ref:approval.ref,
        sha,runId:'123',runAttempt:2,images,files:manifestFiles,schemaFingerprint:schemaFingerprint(manifestFiles)}),{mode:0o600});
    },
  };
  return {root,paths,approval,approvalPath,helpers,source,dependencies,
    counts:() => ({queries,downloads,extracts}),setClock:value => { clock=value; }};
}

test('promotes approved exact artifact to root-owned immutable-by-user tree without deployment',async t => {
  const f=await fixture(t);
  const record=await f.helpers.promoteRelease({sha,runId:123},f.dependencies);
  assert.deepEqual(f.counts(),{queries:2,downloads:1,extracts:1});
  assert.equal(record.verificationLevel,'approved-root-promoted');
  assert.equal(record.deploymentPerformed,false);
  assert.equal(record.bundlePath,join(f.paths.releases,sha));
  assert.equal((await lstat(record.bundlePath)).uid,0);
  assert.equal((await lstat(record.bundlePath)).mode & 0o777,0o700);
  async function checkTree(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name),info=await lstat(path);
      assert.equal(info.uid,0);
      assert.equal(info.mode & 0o077,0);
      assert.equal(info.isSymbolicLink(),false);
      if (entry.isDirectory()) await checkTree(path);
      else assert.equal(info.mode & 0o111,0);
    }
  }
  await checkTree(record.bundlePath);
  const proof=await readFile(join(f.paths.releases,`${sha}.promotion.json`),'utf8');
  assert.equal(JSON.parse(proof).artifactId,456);
  assert.equal(proof.includes('fixture-read-identity'),false);
  assert.deepEqual((await readdir(f.paths.releases)).sort(),[sha,`${sha}.promotion.json`]);
  await assert.rejects(f.helpers.promoteRelease({sha,runId:123},f.dependencies),/PROMOTED_RELEASE_ALREADY_EXISTS/);
});

test('rejects writable ancestors, linked secrets, insecure approval and insecure installed tools before network',async t => {
  for (const kind of ['ancestor','symlink','hardlink','approval','tool']) {
    const f=await fixture(t);
    if (kind === 'ancestor') await chmod(f.root,0o720);
    if (kind === 'approval') await chmod(f.approvalPath,0o644);
    if (kind === 'tool') await chmod(join(f.paths.tools,'stage-release.mjs'),0o622);
    if (kind === 'hardlink') await link(f.paths.token,join(f.root,'extra-link'));
    if (kind === 'symlink') {
      const saved=join(f.root,'saved.token'); await copyFile(f.paths.token,saved); await chmod(saved,0o600);
      await rm(f.paths.token); await symlink(saved,f.paths.token);
    }
    await assert.rejects(f.helpers.promoteRelease({sha,runId:123},f.dependencies),/TRUSTED_ROOT_PATH_REQUIRED/);
    assert.deepEqual(f.counts(),{queries:0,downloads:0,extracts:0});
  }
});

test('refuses revoked, expired or changed approval and a different source attempt without publishing',async t => {
  for (const kind of ['revoked','expired','changed','source']) {
    const f=await fixture(t),download=f.dependencies.download;
    f.dependencies.download=async (...args) => {
      await download(...args);
      if (kind === 'revoked') await rm(f.approvalPath);
      if (kind === 'expired') f.setClock(Date.parse(f.approval.expiresAt));
      if (kind === 'changed') await writeFile(f.approvalPath,JSON.stringify({...f.approval,approvedBy:'different-reviewer'}));
      if (kind === 'source') f.source.runAttempt=3;
    };
    const expected={revoked:{code:'ENOENT'},expired:/CURRENT_EXACT_ROOT_APPROVAL_REQUIRED/,
      changed:/PROMOTION_APPROVAL_CHANGED/,source:/APPROVED_RELEASE_SOURCE_MISMATCH/}[kind];
    await assert.rejects(f.helpers.promoteRelease({sha,runId:123},f.dependencies),expected);
    assert.deepEqual(await readdir(f.paths.releases),[]);
  }
});

test('rejects a mismatched approved source before downloading any bytes',async t => {
  const f=await fixture(t); f.source.artifactId=457;
  await assert.rejects(f.helpers.promoteRelease({sha,runId:123},f.dependencies),/APPROVED_RELEASE_SOURCE_MISMATCH/);
  assert.deepEqual(f.counts(),{queries:1,downloads:0,extracts:0});
  assert.deepEqual(await readdir(f.paths.releases),[]);
});

test('rejects unlisted extracted code and preserves an existing operation lock',async t => {
  const f=await fixture(t),extract=f.dependencies.extract;
  f.dependencies.extract=async (...args) => {
    await extract(...args); await writeFile(join(args[1],'bundle','unlisted.mjs'),'not executable',{mode:0o600});
  };
  await assert.rejects(f.helpers.promoteRelease({sha,runId:123},f.dependencies),/RELEASE_TREE_MISMATCH/);
  assert.deepEqual(await readdir(f.paths.releases),[]);
  const lock=join(f.paths.releases,`.${sha}.promotion-lock`); await mkdir(lock,{mode:0o700});
  await assert.rejects(f.helpers.promoteRelease({sha,runId:123},f.dependencies),{code:'EEXIST'});
  assert.equal((await lstat(lock)).isDirectory(),true);
});
