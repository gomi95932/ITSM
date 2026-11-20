import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeApprovedDeployment, releaseInvocation, validateDeploymentApproval } from '../../scripts/execute-approved-deployment.mjs';

const sha='a'.repeat(40),requestId='d'.repeat(32),now=Date.parse('2026-11-15T03:00:00Z');
const approval={version:1,repository:'gomi95932/ITSM',ref:'refs/heads/main',sha,runId:123,runAttempt:2,
  artifactId:456,artifactDigest:`sha256:${'b'.repeat(64)}`,artifactSize:100,approvedBy:'release-reviewer',
  approvalRef:'change/CHG-001',approvedAt:'2026-11-15T02:00:00Z',expiresAt:'2026-11-15T04:00:00Z',
  requestId,operation:'deploy-development',verifyDevelopment:true,expectedCurrentSha:'e'.repeat(40)};

test('deployment approval requires an explicit baseline, request identity and synthetic verification',() => {
  assert.equal(validateDeploymentApproval(approval,requestId,now),approval);
  assert.equal(validateDeploymentApproval({...approval,expectedCurrentSha:null},requestId,now).expectedCurrentSha,null);
  for (const changes of [{requestId:'f'.repeat(32)},{operation:'rollback'},{verifyDevelopment:false},
    {verifyDevelopment:'true'},{expectedCurrentSha:undefined},{expectedCurrentSha:'main'},
    {expectedCurrentSha:sha.toUpperCase()}])
    assert.throws(() => validateDeploymentApproval({...approval,...changes},requestId,now),/EXACT_DEVELOPMENT_DEPLOYMENT_APPROVAL_REQUIRED/);
  for (const id of [null,{},'../request','d'.repeat(31),'D'.repeat(32)])
    assert.throws(() => validateDeploymentApproval(approval,id,now),/EXACT_DEVELOPMENT_DEPLOYMENT_APPROVAL_REQUIRED/);
  assert.throws(() => validateDeploymentApproval(null,requestId,now),/EXACT_DEVELOPMENT_DEPLOYMENT_APPROVAL_REQUIRED/);
});

test('deployment reuses exact main provenance and bounded approval expiry',() => {
  for (const changes of [{repository:'other/repo'},{ref:'refs/heads/feat/test'},{runAttempt:0},
    {artifactId:0},{artifactDigest:'unverified'},{approvedBy:''},
    {expiresAt:'2026-11-15T03:00:00Z'},{expiresAt:'2026-11-17T04:00:00Z'}])
    assert.throws(() => validateDeploymentApproval({...approval,...changes},requestId,now),/CURRENT_EXACT_ROOT_APPROVAL_REQUIRED/);
});

test('enterprise deployment requires a distinct approval and exact private configuration digest',()=>{
  const enterprise={...approval,operation:'deploy-enterprise-uat',verifyDevelopment:false,verifyEnterpriseUat:true,configurationSha256:'f'.repeat(64)};
  assert.equal(validateDeploymentApproval(enterprise,requestId,now),enterprise);
  for(const changes of [{verifyDevelopment:true},{verifyEnterpriseUat:false},{verifyEnterpriseUat:'true'},
    {configurationSha256:undefined},{configurationSha256:'F'.repeat(64)},{operation:'deploy-development'}])
    assert.throws(()=>validateDeploymentApproval({...enterprise,...changes},requestId,now),/EXACT_DEVELOPMENT_DEPLOYMENT_APPROVAL_REQUIRED/);
  assert.throws(()=>validateDeploymentApproval({...approval,verifyEnterpriseUat:true},requestId,now),/EXACT_DEVELOPMENT_DEPLOYMENT_APPROVAL_REQUIRED/);
});

test('child launch is fixed Node, no shell, sanitized environment and local Docker only',() => {
  const bundle=`/opt/itsm/releases/${sha}`;
  const invocation=releaseInvocation(bundle,['deploy',sha,'--verify-development']);
  assert.equal(invocation.command,'/usr/bin/node');
  assert.deepEqual(invocation.args,[`${bundle}/scripts/release.mjs`,'deploy',sha,'--verify-development']);
  assert.deepEqual(invocation.options,{cwd:bundle,env:{PATH:'/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8',
    DOCKER_CONFIG:'/root/.docker',DOCKER_HOST:'unix:///var/run/docker.sock'},stdio:['ignore','pipe','pipe'],detached:true});
  for (const name of ['NODE_OPTIONS','NODE_PATH','DOCKER_CONTEXT','COMPOSE_FILE','ITSM_API_IMAGE'])
    assert.equal(Object.hasOwn(invocation.options.env,name),false);
});

test('ordinary account cannot execute even a valid approved deployment',async () => {
  if (process.getuid?.() === 0) return;
  await assert.rejects(executeApprovedDeployment(requestId),/ROOT_DEPLOYMENT_REQUIRED/);
});
