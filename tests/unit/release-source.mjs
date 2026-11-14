import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyReleaseSource } from '../../scripts/verify-release-source.mjs';

const sha='a'.repeat(40),runId='123',now=Date.parse('2026-11-15T03:00:00Z');
function fixture() {
  const run={id:123,head_sha:sha,head_branch:'main',event:'push',path:'.github/workflows/app.yml',
    repository:{full_name:'gomi95932/ITSM'},head_repository:{full_name:'gomi95932/ITSM'},
    workflow_id:9,run_attempt:2,status:'completed',conclusion:'success',updated_at:'2026-11-15T02:10:00Z'};
  const names=['build-test','security / secrets','security / sast','security / dependencies',
    'publish-api','publish-web','publish-worker','publish-postgres','publish-redis','release-bundle'];
  const jobs={total_count:names.length,jobs:names.map(name => ({name,run_id:123,head_sha:sha,status:'completed',
    conclusion:'success',started_at:'2026-11-15T02:00:00Z',completed_at:'2026-11-15T02:10:00Z'}))};
  const artifact={id:456,name:`itsm-release-${sha}`,expired:false,size_in_bytes:1024,digest:`sha256:${'b'.repeat(64)}`,
    workflow_run:{id:123,head_sha:sha,head_branch:'main'},created_at:'2026-11-15T02:09:00Z',expires_at:'2026-12-15T02:09:00Z'};
  return {run,jobs,artifacts:{total_count:1,artifacts:[artifact]},workflow:{id:9,path:'.github/workflows/app.yml',state:'active'}};
}
async function check(data,options={}) {
  const requests=[]; let lookups=0;
  const fetchImpl=async (url,init) => {
    requests.push({url,init});
    const path=new URL(url).pathname;
    let result;
    if (path.endsWith('/workflows/app.yml')) result=data.workflow;
    else if (path.endsWith('/jobs')) result=data.jobs;
    else if (path.endsWith('/artifacts')) result=data.artifacts;
    else result=++lookups === 2 && options.finalRun ? options.finalRun : data.run;
    return new Response(JSON.stringify(result));
  };
  const result=await verifyReleaseSource({sha,runId,now,token:'test-read-identity',fetchImpl,...options});
  return {result,requests};
}

test('binds source evidence to successful main SHA, exact attempt and immutable artifact',async () => {
  const {result,requests}=await check(fixture());
  assert.equal(result.sha,sha); assert.equal(result.runAttempt,2);
  assert.equal(result.artifactId,456); assert.equal(result.verificationLevel,'github-source-only');
  assert.equal(result.artifactDigest,`sha256:${'b'.repeat(64)}`);
  assert.ok(requests.some(request => request.url.includes('/attempts/2/jobs?per_page=100')));
  assert.ok(requests.every(request => request.url.startsWith('https://api.github.com/repos/gomi95932/ITSM/')
    && request.init.redirect === 'error' && request.init.headers.Authorization === 'Bearer test-read-identity'));
  assert.equal(JSON.stringify(result).includes('test-read-identity'),false);
});

test('rejects PRs, branch runs, wrong workflow or repository and incomplete runs',async () => {
  for (const change of [{event:'pull_request'},{head_branch:'feat/example'},{head_sha:'c'.repeat(40)},
    {id:124},{workflow_id:10},{run_attempt:0},{path:'.github/workflows/other.yml'},
    {status:'in_progress'},{conclusion:'failure'},{repository:{full_name:'other/ITSM'}},
    {head_repository:{full_name:'other/ITSM'}}]) {
    const data=fixture(); Object.assign(data.run,change);
    await assert.rejects(check(data),/SUCCESSFUL_MAIN_RELEASE_REQUIRED/);
  }
});

test('rejects missing, duplicate, skipped and foreign release gates and truncated listings',async () => {
  for (let i=0;i<10;i++) {
    const data=fixture(); data.jobs.jobs[i].conclusion='skipped';
    await assert.rejects(check(data),/ALL_RELEASE_GATES_REQUIRED/);
  }
  for (const mutate of [data => data.jobs.total_count++,data => data.jobs.jobs.pop(),
    data => { data.jobs.jobs.push({...data.jobs.jobs[0]}); data.jobs.total_count++; },
    data => { data.jobs.jobs[0].run_id=124; },data => { data.jobs.jobs[0].head_sha='c'.repeat(40); }]) {
    const data=fixture(); mutate(data);
    await assert.rejects(check(data),/RELEASE_(JOBS|GATES)_REQUIRED/);
  }
});

test('rejects artifact ambiguity, expiration, weak digests and prior-attempt artifacts',async () => {
  for (const change of [{expired:true},{digest:null},{digest:'not-a-digest'},{size_in_bytes:0},
    {size_in_bytes:101*1024*1024},{expires_at:'2026-11-14T00:00:00Z'},
    {created_at:'2026-11-15T01:59:59Z'},{created_at:'2026-11-15T02:10:01Z'},
    {created_at:'not-a-date'},{workflow_run:{id:124,head_sha:sha,head_branch:'main'}}]) {
    const data=fixture(); Object.assign(data.artifacts.artifacts[0],change);
    await assert.rejects(check(data),/CURRENT_ATTEMPT_ARTIFACT_REQUIRED/);
  }
  for (const mutate of [data => { data.artifacts={total_count:0,artifacts:[]}; },
    data => { data.artifacts.artifacts.push({...data.artifacts.artifacts[0]}); data.artifacts.total_count++; }]) {
    const data=fixture(); mutate(data);
    await assert.rejects(check(data),/UNIQUE_RELEASE_ARTIFACT_REQUIRED/);
  }
});

test('rejects reruns or changed state during verification',async () => {
  const data=fixture();
  await assert.rejects(check(data,{finalRun:{...data.run,run_attempt:3}}),/SOURCE_CHANGED/);
  await assert.rejects(check(data,{finalRun:{...data.run,updated_at:'2026-11-15T02:11:00Z'}}),/SOURCE_CHANGED/);
});

test('never forwards identities to redirects or includes upstream diagnostics',async () => {
  for (const fetchImpl of [async () => { throw new Error('sensitive-upstream-response'); },
    async () => new Response('sensitive-upstream-response',{status:403}),
    async () => new Response('not-json'),async () => new Response('x'.repeat(2*1024*1024+1))])
    await assert.rejects(verifyReleaseSource({sha,runId,now,token:'test-read-identity',fetchImpl}),
      error => error.message === 'GITHUB_SOURCE_LOOKUP_FAILED');
});

test('requires exact numeric selection and a separate read identity before requests',async () => {
  const fetchImpl=async () => { assert.fail('invalid input must not call GitHub'); };
  for (const change of [{sha:'main'},{runId:'1/../../other'},{runId:'01'},{runId:'9007199254740992'}])
    await assert.rejects(verifyReleaseSource({sha,runId,token:'test',fetchImpl,...change}),/EXACT_RELEASE_SELECTION/);
  for (const token of [undefined,'','  ','test\nidentity'])
    await assert.rejects(verifyReleaseSource({sha,runId,token,fetchImpl}),/GITHUB_READ_IDENTITY_REQUIRED/);
});
