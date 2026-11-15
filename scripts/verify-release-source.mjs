import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository='gomi95932/ITSM';
const base=`https://api.github.com/repos/${repository}`;
const requiredJobs=Object.freeze(['build-test','security / secrets','security / sast','security / dependencies',
  'publish-api','publish-web','publish-worker','publish-postgres','publish-redis','release-bundle']);
const positiveId=value => Number.isSafeInteger(value) && value > 0;

export function validateSourceSelection(sha,runId) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[1-9][0-9]*$/.test(String(runId))
    || !positiveId(Number(runId))) throw new Error('EXACT_RELEASE_SELECTION_REQUIRED');
}

export function validateSourceRun(run,sha,runId,workflowId) {
  if (run.id !== Number(runId) || run.head_sha !== sha || run.head_branch !== 'main'
    || run.event !== 'push' || run.path !== '.github/workflows/app.yml'
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.workflow_id !== workflowId || !positiveId(workflowId) || !positiveId(run.run_attempt)
    || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('SUCCESSFUL_MAIN_RELEASE_REQUIRED');
}

export function validateSourceJobs(page,sha,runId) {
  if (!Array.isArray(page.jobs) || page.total_count !== page.jobs.length || page.jobs.length > 100)
    throw new Error('COMPLETE_RELEASE_JOBS_REQUIRED');
  for (const name of requiredJobs) {
    const matches=page.jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].run_id !== Number(runId) || matches[0].head_sha !== sha
      || matches[0].status !== 'completed' || matches[0].conclusion !== 'success')
      throw new Error('ALL_RELEASE_GATES_REQUIRED');
  }
  return page.jobs.find(job => job.name === 'release-bundle');
}

export function validateSourceArtifact(page,sha,runId,releaseJob,now) {
  if (!Array.isArray(page.artifacts) || page.total_count !== page.artifacts.length || page.artifacts.length > 100)
    throw new Error('COMPLETE_RELEASE_ARTIFACTS_REQUIRED');
  const matches=page.artifacts.filter(artifact => artifact.name === `itsm-release-${sha}`);
  if (matches.length !== 1) throw new Error('UNIQUE_RELEASE_ARTIFACT_REQUIRED');
  const artifact=matches[0],created=Date.parse(artifact.created_at),expires=Date.parse(artifact.expires_at);
  const started=Date.parse(releaseJob.started_at),completed=Date.parse(releaseJob.completed_at);
  if (!positiveId(artifact.id) || artifact.expired !== false || !positiveId(artifact.size_in_bytes)
    || artifact.size_in_bytes > 100*1024*1024 || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
    || artifact.workflow_run?.id !== Number(runId) || artifact.workflow_run?.head_sha !== sha
    || artifact.workflow_run?.head_branch !== 'main'
    || ![created,expires,started,completed,now].every(Number.isFinite)
    || created < started || created > completed || expires <= now || created > now)
    throw new Error('CURRENT_ATTEMPT_ARTIFACT_REQUIRED');
  return artifact;
}

async function githubJson(path,token,fetchImpl) {
  try {
    const response=await fetchImpl(`${base}${path}`,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{
      Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28',
    }});
    if (!response.ok) throw new Error('GITHUB_SOURCE_LOOKUP_FAILED');
    const chunks=[]; let size=0;
    for await (const chunk of response.body) {
      size+=chunk.byteLength;
      if (size > 2*1024*1024) throw new Error('GITHUB_SOURCE_LOOKUP_FAILED');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error('GITHUB_SOURCE_LOOKUP_FAILED'); }
}

export async function verifyReleaseSource({sha,runId,token,fetchImpl=fetch,now=Date.now()}) {
  validateSourceSelection(sha,runId);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('GITHUB_READ_IDENTITY_REQUIRED');
  const get=path => githubJson(path,token,fetchImpl);
  const workflow=await get('/actions/workflows/app.yml');
  if (workflow.path !== '.github/workflows/app.yml' || workflow.state !== 'active') throw new Error('EXPECTED_WORKFLOW_REQUIRED');
  const run=await get(`/actions/runs/${runId}`);
  validateSourceRun(run,sha,runId,workflow.id);
  const jobs=await get(`/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const releaseJob=validateSourceJobs(jobs,sha,runId);
  const artifact=validateSourceArtifact(await get(`/actions/runs/${runId}/artifacts?per_page=100`),sha,runId,releaseJob,now);
  const finalRun=await get(`/actions/runs/${runId}`);
  validateSourceRun(finalRun,sha,runId,workflow.id);
  if (finalRun.run_attempt !== run.run_attempt || finalRun.updated_at !== run.updated_at)
    throw new Error('RELEASE_SOURCE_CHANGED_DURING_CHECK');
  return {repository,sha,runId:Number(runId),runAttempt:run.run_attempt,workflowId:workflow.id,
    runUrl:`https://github.com/${repository}/actions/runs/${runId}`,artifactId:artifact.id,
    artifactName:artifact.name,artifactDigest:artifact.digest,artifactSize:artifact.size_in_bytes,
    downloadApiUrl:`${base}/actions/artifacts/${artifact.id}/zip`,verifiedAt:new Date(now).toISOString(),
    verificationLevel:'github-source-only'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha,runId,...extra]=process.argv.slice(2);
  Promise.resolve().then(() => {
    if (extra.length) throw new Error('EXACT_RELEASE_SELECTION_REQUIRED');
    return verifyReleaseSource({sha,runId,token:process.env.ITSM_GITHUB_READ_TOKEN ?? process.env.GITHUB_TOKEN});
  }).then(result => console.log(JSON.stringify(result,null,2))).catch(error => {
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_SOURCE_CHECK_FAILED');
    process.exitCode=1;
  });
}
