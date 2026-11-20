import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { recoveryMethod, requiredReleaseFiles, schemaFingerprint, validateRelease } from './release.mjs';

const [sha,destination]=process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !destination || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== 'gomi95932/ITSM')
  throw new Error('ONLY_MAIN_RELEASES_CAN_BE_PACKAGED');
for (const value of [process.env.GITHUB_RUN_ID,process.env.GITHUB_RUN_ATTEMPT])
  if (!/^[1-9][0-9]*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) throw new Error('EXACT_RELEASE_RUN_REQUIRED');
if (execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() !== sha) throw new Error('COMMIT_MISMATCH');
const paths=requiredReleaseFiles.filter(path => !path.startsWith('db/migrations/'));
// Legacy bundles remain valid rollback targets; every new bundle includes its hashed acceptance tool.
paths.push('scripts/verify-development.mjs');
paths.push('scripts/verify-enterprise-uat.mjs');
paths.push('docs/enterprise-uat-runbook.md');
paths.push('scripts/verify-release-source.mjs');
paths.push('scripts/stage-release.mjs');
paths.push('scripts/extract-release.py');
paths.push('scripts/promote-release.mjs');
paths.push('scripts/execute-approved-deployment.mjs');
paths.push('scripts/inspect-development.mjs');
paths.push('infra/systemd/itsm-deploy-approved@.service');
const images={};
for (const name of ['api','web','worker','postgres','redis']) {
  const repository=`ghcr.io/gomi95932/itsm-${name}`;
  const image=`${repository}:${sha}`;
  execFileSync('docker',['pull',image],{stdio:'inherit'});
  const digests=JSON.parse(execFileSync('docker',['image','inspect',image,'--format','{{json .RepoDigests}}'],{encoding:'utf8'}));
  const digest=digests.find(value => value.startsWith(`${repository}@sha256:`));
  if (!digest || !/^[a-f0-9]{64}$/.test(digest.split('@sha256:')[1])) throw new Error('IMAGE_DIGEST_MISSING');
  images[name]=digest;
}
for (const name of (await readdir('db/migrations')).sort()) if (/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) paths.push(`db/migrations/${name}`);
const files=[];
for (const path of paths) {
  const target=resolve(destination,path); await mkdir(dirname(target),{recursive:true}); await copyFile(path,target);
  files.push({path,sha256:createHash('sha256').update(await readFile(target)).digest('hex')});
}
await writeFile(resolve(destination,'release.json'),`${JSON.stringify({
  sha,repository:process.env.GITHUB_REPOSITORY,ref:process.env.GITHUB_REF,runId:process.env.GITHUB_RUN_ID,
  runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),
  schemaFingerprint:schemaFingerprint(files),files,images,recoveryVerification:recoveryMethod,
},null,2)}\n`,{flag:'wx'});
await validateRelease(destination,sha);
console.log(`Release bundle prepared for ${sha}; no environment files or credentials included`);
