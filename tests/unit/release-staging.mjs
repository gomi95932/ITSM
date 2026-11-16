import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { requiredReleaseFiles, schemaFingerprint } from '../../scripts/release.mjs';
import { downloadReleaseArtifact, stageRelease, validateArtifactRedirect, validateStagedRelease } from '../../scripts/stage-release.mjs';

const sha='a'.repeat(40),bytes=Buffer.from('verified-zip-fixture');
const source={sha,runId:123,runAttempt:2,artifactId:456,artifactSize:bytes.length,
  artifactDigest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  downloadApiUrl:'https://api.github.com/repos/gomi95932/ITSM/actions/artifacts/456/zip'};
async function temporary(t) {
  const path=await mkdtemp(join(await realpath(tmpdir()),'itsm-stage-test-'));
  t.after(() => rm(path,{recursive:true,force:true}));
  return path;
}
async function createBundle(bundle,changes={}) {
  await mkdir(bundle,{recursive:true,mode:0o700});
  const files=[];
  for (const path of [...requiredReleaseFiles,'scripts/verify-development.mjs']) {
    await mkdir(dirname(join(bundle,path)),{recursive:true});
    await writeFile(join(bundle,path),`fixture ${path}`);
    files.push({path,sha256:createHash('sha256').update(`fixture ${path}`).digest('hex')});
  }
  const images=Object.fromEntries(['api','web','worker','postgres','redis'].map(name =>
    [name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'b'.repeat(64)}`]));
  await writeFile(join(bundle,'release.json'),JSON.stringify({repository:'gomi95932/ITSM',ref:'refs/heads/main',
    sha,runId:'123',runAttempt:2,files,images,schemaFingerprint:schemaFingerprint(files),...changes}));
}

test('only permits signed HTTPS artifact storage locations',() => {
  assert.equal(validateArtifactRedirect('https://production.blob.core.windows.net/file?sig=fixture'),
    'https://production.blob.core.windows.net/file?sig=fixture');
  for (const value of [null,'https://127.0.0.1/a','http://production.blob.core.windows.net/a',
    'https://production.blob.core.windows.net.example.com/a','https://example.com/a',
    'https://user@production.blob.core.windows.net/a','https://production.blob.core.windows.net:444/a',
    'https://production.blob.core.windows.net/a#fragment'])
    assert.throws(() => validateArtifactRedirect(value),/ARTIFACT_REDIRECT_REJECTED/);
});

test('validates actual downloaded digest and size without forwarding the GitHub identity',async t => {
  const root=await temporary(t),requests=[];
  const fetchImpl=async (url,options) => {
    requests.push({url,options});
    return requests.length === 1 ? new Response(null,{status:302,headers:{location:'https://production.blob.core.windows.net/archive?sig=fixture'}})
      : new Response(bytes,{headers:{'content-length':String(bytes.length)}});
  };
  await downloadReleaseArtifact(source,'test-read-identity',join(root,'artifact.zip'),{fetchImpl});
  assert.deepEqual(await readFile(join(root,'artifact.zip')),bytes);
  assert.equal(requests[0].options.headers.Authorization,'Bearer test-read-identity');
  assert.equal(requests[1].options.headers,undefined);
  assert.equal(requests[1].options.redirect,'error');
});

test('rejects digest mismatch, truncation, overrun and untrusted API selection',async t => {
  const root=await temporary(t); let i=0;
  for (const [body,expected] of [[Buffer.from('x'.repeat(bytes.length)),/ARTIFACT_DIGEST_MISMATCH/],
    [bytes.subarray(1),/ARTIFACT_SIZE_MISMATCH/],[Buffer.concat([bytes,bytes]),/ARTIFACT_SIZE_MISMATCH/]])
    await assert.rejects(downloadReleaseArtifact(source,'test',join(root,`artifact-${i++}`),{
      fetchImpl:async () => new Response(body),
    }),expected);
  await assert.rejects(downloadReleaseArtifact({...source,downloadApiUrl:'https://example.com'},'test',join(root,'invalid'),{
    fetchImpl:async () => assert.fail('must not request invalid origin'),
  }),/ARTIFACT_SELECTION_REJECTED/);
});

test('rejects unsigned redirect targets and redacts network diagnostics',async t => {
  const root=await temporary(t);
  await assert.rejects(downloadReleaseArtifact(source,'test',join(root,'bad-redirect'),{
    fetchImpl:async () => new Response(null,{status:302,headers:{location:'https://example.com/private?token=sensitive'}}),
  }),error => error.message === 'ARTIFACT_REDIRECT_REJECTED');
  await assert.rejects(downloadReleaseArtifact(source,'test',join(root,'failure'),{
    fetchImpl:async () => { throw new Error('sensitive signed URL or identity'); },
  }),error => error.message === 'ARTIFACT_DOWNLOAD_FAILED');
});

test('binds the manifest to the exact attempt and rejects unlisted files',async t => {
  const root=await temporary(t),bundle=join(root,'bundle');
  await createBundle(bundle);
  assert.equal((await validateStagedRelease(bundle,source)).sha,sha);
  await assert.rejects(validateStagedRelease(bundle,{...source,runAttempt:3}),/RELEASE_RUN_BINDING_MISMATCH/);
  await assert.rejects(validateStagedRelease(bundle,{...source,runId:124}),/RELEASE_RUN_BINDING_MISMATCH/);
  await writeFile(join(bundle,'unlisted.mjs'),'must not execute');
  await assert.rejects(validateStagedRelease(bundle,source),/RELEASE_TREE_MISMATCH/);
});

test('publishes verified staging evidence without invoking a deployment',async t => {
  const root=await temporary(t),destination=join(root,'release'); let calls=0;
  const result=await stageRelease({sha,runId:123,destination,token:'test-read-identity',
    verifySource:async () => { calls++; return {...source}; },fetchImpl:async () => new Response(bytes),
    extract:async (_artifact,target) => createBundle(join(target,'bundle')),
  });
  assert.equal(calls,2); assert.equal(result.verificationLevel,'artifact-verified');
  assert.equal(result.bundlePath,join(destination,'verified','bundle'));
  assert.equal((await lstat(destination)).mode & 0o777,0o700);
  const proof=await readFile(join(destination,'verified','release-staging.json'),'utf8');
  assert.equal(JSON.parse(proof).artifactDigest,source.artifactDigest);
  assert.equal(proof.includes('test-read-identity'),false);
  assert.deepEqual(await readdir(destination),['verified']);
  await assert.rejects(stageRelease({sha,runId:123,destination,token:'test',verifySource:async () => source}),{code:'EEXIST'});
});

test('does not publish a result after a changed source or unsafe directory',async t => {
  const root=await temporary(t),destination=join(root,'release'); let calls=0;
  await assert.rejects(stageRelease({sha,runId:123,destination,token:'test',
    verifySource:async () => ({...source,artifactId:++calls === 1 ? 456 : 457}),
    fetchImpl:async () => new Response(bytes),extract:async (_artifact,target) => createBundle(join(target,'bundle')),
  }),/RELEASE_SOURCE_CHANGED_DURING_STAGING/);
  assert.deepEqual(await readdir(destination),[]);
  await chmod(root,0o755);
  await assert.rejects(stageRelease({sha,runId:123,destination:join(root,'other'),token:'test',
    verifySource:async () => assert.fail('must reject non-private parent before requests'),
  }),/PRIVATE_OWNED_STAGING_PARENT_REQUIRED/);
});
