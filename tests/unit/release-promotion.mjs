import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindApprovedSource, promoteRelease, validatePromotionApproval } from '../../scripts/promote-release.mjs';

const sha='a'.repeat(40),now=Date.parse('2026-11-15T03:00:00Z');
const approval={version:1,repository:'gomi95932/ITSM',ref:'refs/heads/main',sha,runId:123,runAttempt:2,
  artifactId:456,artifactDigest:`sha256:${'b'.repeat(64)}`,artifactSize:100,approvedBy:'release-reviewer',
  approvalRef:'change/CHG-001',approvedAt:'2026-11-15T02:00:00Z',expiresAt:'2026-11-15T04:00:00Z'};

test('promotion approval binds exact main run, attempt, artifact and bounded lifetime',() => {
  assert.equal(validatePromotionApproval(approval,sha,123,now),approval);
  const invalid=[{version:2},{repository:'other/repo'},{ref:'refs/heads/feat/test'},{sha:'c'.repeat(40)},
    {runId:'123'},{runAttempt:0},{artifactId:0},{artifactSize:101*1024*1024},{artifactDigest:'unverified'},
    {approvedBy:''},{approvalRef:'bad\nreference'},{approvedAt:'2026-11-15T03:01:00Z'},
    {expiresAt:'2026-11-15T03:00:00Z'},{expiresAt:'2026-11-17T04:00:00Z'},{approvedAt:'invalid'}];
  for (const changes of invalid)
    assert.throws(() => validatePromotionApproval({...approval,...changes},sha,123,now),/CURRENT_EXACT_ROOT_APPROVAL_REQUIRED/);
  assert.throws(() => validatePromotionApproval(null,sha,123,now),/CURRENT_EXACT_ROOT_APPROVAL_REQUIRED/);
});

test('source must match every approved field, not just the code SHA',() => {
  const source={...approval,verificationLevel:'github-source-only'};
  bindApprovedSource(approval,source);
  for (const key of ['sha','runId','runAttempt','artifactId','artifactDigest','artifactSize','repository','verificationLevel'])
    assert.throws(() => bindApprovedSource(approval,{...source,[key]:null}),/APPROVED_RELEASE_SOURCE_MISMATCH/);
});

test('ordinary account cannot invoke privileged promotion',async () => {
  if (process.getuid?.() === 0) return;
  await assert.rejects(promoteRelease({sha,runId:123}),/ROOT_PROMOTION_REQUIRED/);
});
