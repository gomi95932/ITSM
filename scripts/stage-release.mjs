import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateRelease } from './release.mjs';
import { validateSourceSelection, verifyReleaseSource } from './verify-release-source.mjs';

const execute=promisify(execFile),maxArtifactBytes=100*1024*1024;
const repository='gomi95932/ITSM';

export function validateArtifactRedirect(value) {
  let url;
  try { url=new URL(value); } catch { throw new Error('ARTIFACT_REDIRECT_REJECTED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || !['.blob.core.windows.net','.actions.githubusercontent.com'].some(suffix => url.hostname.endsWith(suffix)))
    throw new Error('ARTIFACT_REDIRECT_REJECTED');
  return url.href;
}

export async function downloadReleaseArtifact(source,token,path,{fetchImpl=fetch}={}) {
  const expectedUrl=`https://api.github.com/repos/${repository}/actions/artifacts/${source.artifactId}/zip`;
  if (!Number.isSafeInteger(source.artifactId) || source.artifactId <= 0 || source.downloadApiUrl !== expectedUrl
    || !Number.isSafeInteger(source.artifactSize) || source.artifactSize <= 0 || source.artifactSize > maxArtifactBytes
    || !/^sha256:[a-f0-9]{64}$/.test(source.artifactDigest ?? '')) throw new Error('ARTIFACT_SELECTION_REJECTED');
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('GITHUB_READ_IDENTITY_REQUIRED');
  let file;
  try {
    const signal=AbortSignal.timeout(60000);
    let response=await fetchImpl(expectedUrl,{redirect:'manual',signal,headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28',
    }});
    if (response.status === 302) {
      const location=validateArtifactRedirect(response.headers.get('location'));
      await response.body?.cancel();
      // The signed object-store URL receives no GitHub identity and cannot redirect again.
      response=await fetchImpl(location,{redirect:'error',signal});
    }
    if (response.status !== 200 || !response.body) throw new Error('ARTIFACT_DOWNLOAD_FAILED');
    const length=response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== source.artifactSize))
      throw new Error('ARTIFACT_SIZE_MISMATCH');
    file=await open(path,'wx',0o600);
    const hash=createHash('sha256'); let size=0;
    for await (const chunk of response.body) {
      size+=chunk.byteLength;
      if (size > source.artifactSize || size > maxArtifactBytes) throw new Error('ARTIFACT_SIZE_MISMATCH');
      hash.update(chunk); await file.writeFile(chunk);
    }
    if (size !== source.artifactSize) throw new Error('ARTIFACT_SIZE_MISMATCH');
    if (`sha256:${hash.digest('hex')}` !== source.artifactDigest) throw new Error('ARTIFACT_DIGEST_MISMATCH');
    await file.sync();
  } catch (error) {
    if (error instanceof Error && /^ARTIFACT_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error('ARTIFACT_DOWNLOAD_FAILED');
  } finally { await file?.close(); }
}

export async function validateStagedRelease(bundle,source) {
  const manifest=await validateRelease(bundle,source.sha,{requireBusinessAcceptance:true});
  if (String(manifest.runId) !== String(source.runId) || manifest.runAttempt !== source.runAttempt)
    throw new Error('RELEASE_RUN_BINDING_MISMATCH');
  const expected=new Set(['release.json',...manifest.files.map(file => file.path)]),actual=[];
  async function walk(directory,prefix='') {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const relative=prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory,entry.name),relative);
      else if (entry.isFile()) actual.push(relative);
      else throw new Error('RELEASE_TREE_MISMATCH');
    }
  }
  await walk(bundle);
  if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error('RELEASE_TREE_MISMATCH');
  return manifest;
}

async function extractArtifact(artifact,destination,sha) {
  try {
    await execute('/usr/bin/python3',[fileURLToPath(new URL('./extract-release.py',import.meta.url)),artifact,destination,sha],{
      timeout:45000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},
    });
  } catch { throw new Error('UNSAFE_RELEASE_ARCHIVE'); }
}

export async function stageRelease({sha,runId,destination,token,fetchImpl=fetch,
  verifySource=verifyReleaseSource,extract=extractArtifact}) {
  validateSourceSelection(sha,runId);
  if (process.getuid?.() === 0) throw new Error('UNPRIVILEGED_STAGING_REQUIRED');
  if (!destination || !isAbsolute(destination) || resolve(destination) !== destination)
    throw new Error('ABSOLUTE_NEW_STAGING_DIRECTORY_REQUIRED');
  const parent=dirname(destination),info=await lstat(parent);
  if (!info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid?.()
    || await realpath(parent) !== parent) throw new Error('PRIVATE_OWNED_STAGING_PARENT_REQUIRED');
  const source=await verifySource({sha,runId,token,fetchImpl});
  // Reserve the final destination exclusively; never replace an existing release or staging result.
  await mkdir(destination,{mode:0o700});
  const work=await mkdtemp(join(destination,'.incoming-'));
  try {
    const artifact=join(work,'artifact.zip'),extracted=join(work,'extracted');
    await downloadReleaseArtifact(source,token,artifact,{fetchImpl});
    await extract(artifact,extracted,sha);
    const manifest=await validateStagedRelease(join(extracted,'bundle'),source);
    const finalSource=await verifySource({sha,runId,token,fetchImpl});
    for (const key of ['sha','runId','runAttempt','artifactId','artifactDigest','artifactSize'])
      if (finalSource[key] !== source[key]) throw new Error('RELEASE_SOURCE_CHANGED_DURING_STAGING');
    const result={repository,sha,runId:source.runId,runAttempt:source.runAttempt,artifactId:source.artifactId,
      artifactDigest:source.artifactDigest,artifactSize:source.artifactSize,
      bundlePath:join(destination,'verified','bundle'),schemaFingerprint:manifest.schemaFingerprint,
      images:manifest.images,verifiedAt:new Date().toISOString(),verificationLevel:'artifact-verified'};
    await writeFile(join(extracted,'release-source.json'),`${JSON.stringify(finalSource,null,2)}\n`,{flag:'wx',mode:0o600});
    await writeFile(join(extracted,'release-staging.json'),`${JSON.stringify(result,null,2)}\n`,{flag:'wx',mode:0o600});
    await rename(extracted,join(destination,'verified'));
    return result;
  } finally { await rm(work,{recursive:true,force:true}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha,runId,destination,...extra]=process.argv.slice(2);
  Promise.resolve().then(() => {
    if (extra.length) throw new Error('EXACT_RELEASE_SELECTION_REQUIRED');
    return stageRelease({sha,runId,destination,token:process.env.ITSM_GITHUB_READ_TOKEN ?? process.env.GITHUB_TOKEN});
  }).then(result => console.log(JSON.stringify(result,null,2))).catch(error => {
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_STAGING_FAILED');
    process.exitCode=1;
  });
}
