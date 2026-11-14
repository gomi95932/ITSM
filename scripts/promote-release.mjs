import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadReleaseArtifact, extractArtifact, validateStagedRelease } from './stage-release.mjs';
import { validateSourceSelection, verifyReleaseSource } from './verify-release-source.mjs';

const repository='gomi95932/ITSM';
const installedTools='/opt/itsm/tools/release';
const installedPaths=Object.freeze({tools:installedTools,releases:'/opt/itsm/releases',
  approvals:'/opt/itsm/shared/release-approvals',token:'/etc/itsm/github-actions-read.token'});
const trustedTools=Object.freeze(['promote-release.mjs','stage-release.mjs','release.mjs',
  'verify-release-source.mjs','extract-release.py']);
const sourceKeys=Object.freeze(['sha','runId','runAttempt','artifactId','artifactDigest','artifactSize']);

export function validatePromotionApproval(approval,sha,runId,now=Date.now()) {
  validateSourceSelection(sha,runId);
  const approved=Date.parse(approval?.approvedAt),expires=Date.parse(approval?.expiresAt);
  if (approval?.version !== 1 || approval.repository !== repository || approval.ref !== 'refs/heads/main'
    || approval.sha !== sha || approval.runId !== Number(runId)
    || ![approval.runAttempt,approval.artifactId,approval.artifactSize].every(v => Number.isSafeInteger(v) && v > 0)
    || approval.artifactSize > 100*1024*1024 || !/^sha256:[a-f0-9]{64}$/.test(approval.artifactDigest ?? '')
    || !/^[A-Za-z0-9@._:-]{1,120}$/.test(approval.approvedBy ?? '')
    || !/^[A-Za-z0-9._:/#-]{1,200}$/.test(approval.approvalRef ?? '')
    || ![approved,expires,now].every(Number.isFinite) || approved > now || expires <= now
    || expires <= approved || expires-approved > 24*60*60*1000)
    throw new Error('CURRENT_EXACT_ROOT_APPROVAL_REQUIRED');
  return approval;
}

export function bindApprovedSource(approval,source) {
  if (source?.repository !== repository || source.verificationLevel !== 'github-source-only'
    || sourceKeys.some(key => source[key] !== approval[key])) throw new Error('APPROVED_RELEASE_SOURCE_MISMATCH');
}

export async function requireRootOwnedPath(path,{directory=false,privateFile=false}={}) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('TRUSTED_ROOT_PATH_REQUIRED');
  // Validate every ancestor, not only the leaf: no user-writable parent can swap a trusted file.
  let cursor=path,leaf=true;
  while (true) {
    const info=await lstat(cursor);
    if (info.uid !== 0 || (info.mode & 0o022) || info.isSymbolicLink()
      || (leaf && !directory ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
      || (leaf && privateFile && (info.mode & 0o077))) throw new Error('TRUSTED_ROOT_PATH_REQUIRED');
    if (cursor === '/') break;
    cursor=dirname(cursor); leaf=false;
  }
  if (await realpath(path) !== path) throw new Error('TRUSTED_ROOT_PATH_REQUIRED');
}

async function readPrivate(path,limit) {
  await requireRootOwnedPath(path,{privateFile:true});
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info=await file.stat();
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o077) || info.size > limit)
      throw new Error('PRIVATE_ROOT_FILE_REQUIRED');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export async function promoteRelease({sha,runId},{paths=installedPaths,verifySource=verifyReleaseSource,
  download=downloadReleaseArtifact,extract=extractArtifact,now=Date.now}={}) {
  validateSourceSelection(sha,runId);
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new Error('ROOT_PROMOTION_REQUIRED');
  for (const directory of [paths.tools,paths.releases,paths.approvals])
    await requireRootOwnedPath(directory,{directory:true});
  for (const file of trustedTools) await requireRootOwnedPath(join(paths.tools,file));
  const approvalPath=join(paths.approvals,`${sha}.json`);
  const approval=validatePromotionApproval(JSON.parse(await readPrivate(approvalPath,16384)),sha,runId,now());
  const token=(await readPrivate(paths.token,8192)).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('GITHUB_READ_IDENTITY_REQUIRED');
  const destination=join(paths.releases,sha),recordPath=join(paths.releases,`${sha}.promotion.json`);
  for (const path of [destination,recordPath]) {
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('PROMOTED_RELEASE_ALREADY_EXISTS');
  }
  const lock=join(paths.releases,`.${sha}.promotion-lock`);
  await mkdir(lock,{mode:0o700});
  let work;
  try {
    work=await mkdtemp(join(paths.releases,'.promotion-'));
    const source=await verifySource({sha,runId,token});
    bindApprovedSource(approval,source);
    const artifact=join(work,'artifact.zip'),extracted=join(work,'extracted');
    await download(source,token,artifact);
    await extract(artifact,extracted,sha);
    const bundle=join(extracted,'bundle');
    const manifest=await validateStagedRelease(bundle,source);
    const finalSource=await verifySource({sha,runId,token});
    bindApprovedSource(approval,finalSource);
    // Approval expiry, revocation and source changes are checked again just before publication.
    const finalApproval=validatePromotionApproval(JSON.parse(await readPrivate(approvalPath,16384)),sha,runId,now());
    if (JSON.stringify(finalApproval) !== JSON.stringify(approval)) throw new Error('PROMOTION_APPROVAL_CHANGED');
    if (sourceKeys.some(key => finalSource[key] !== source[key])) throw new Error('PROMOTION_SOURCE_CHANGED');
    const record={repository,sha,runId:source.runId,runAttempt:source.runAttempt,artifactId:source.artifactId,
      artifactDigest:source.artifactDigest,artifactSize:source.artifactSize,bundlePath:destination,
      schemaFingerprint:manifest.schemaFingerprint,images:manifest.images,approvedBy:approval.approvedBy,
      approvalRef:approval.approvalRef,approvedAt:approval.approvedAt,promotedAt:new Date(now()).toISOString(),
      verificationLevel:'approved-root-promoted',deploymentPerformed:false};
    await writeFile(join(work,'promotion.json'),`${JSON.stringify(record,null,2)}\n`,{flag:'wx',mode:0o600});
    await rename(bundle,destination);
    // A crash between these renames needs manual reconciliation; never execute a bundle without its record.
    await rename(join(work,'promotion.json'),recordPath);
    return record;
  } finally {
    if (work) await rm(work,{recursive:true,force:true});
    await rm(lock,{recursive:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha,runId,...extra]=process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (extra.length || dirname(fileURLToPath(import.meta.url)) !== installedTools)
      throw new Error('INSTALLED_FIXED_PROMOTION_ENTRY_REQUIRED');
    return promoteRelease({sha,runId});
  }).then(result => console.log(JSON.stringify(result,null,2))).catch(error => {
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_PROMOTION_FAILED');
    process.exitCode=1;
  });
}
