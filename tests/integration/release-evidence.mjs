import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const [path,sha]=process.argv.slice(2);
assert.match(sha ?? '',/^[a-f0-9]{40}$/);
assert.equal(resolve(path),resolve(process.env.RUNNER_TEMP,'itsm-release-rehearsal-state/current.json'));
const record=JSON.parse(await readFile(path,'utf8'));
assert.equal(record.sha,sha);
assert.equal(record.verificationLevel,'synthetic-business');
assert.match(record.schemaFingerprint,/^[a-f0-9]{64}$/);
assert.ok(record.backup);
assert.equal(record.businessAcceptance.status,'passed');
assert.equal(record.businessAcceptance.profile,'phase1-waiting-v2');
assert.equal(record.businessAcceptance.ticketIds.length,1);
for (const check of ['readiness','anonymous-access','create-idempotency','cross-user-isolation',
  'employee-role','action-idempotency','stale-write-conflict','personal-ownership','agent-resolution',
  'requester-confirmation','internal-evidence-hidden','requester-feedback','waiting-validation','waiting-idempotency',
  'user-waiting-resolution-pause','requester-supplement-resume','cross-user-supplement-isolation',
  'vendor-waiting-sla-continues','vendor-resume-owner-boundary','vendor-resume-comment','vendor-resume-idempotency',
  'vendor-resume-clears-metadata','vendor-resume-sla-preserved','waiting-closure-clears-metadata'])
  assert.ok(record.businessAcceptance.checks.includes(check));
assert.ok(Date.parse(record.businessAcceptance.completedAt) <= Date.parse(record.verifiedAt));
for (const [service,image] of Object.entries({db:'postgres',redis:'redis',api:'api',worker:'worker',web:'web'})) {
  assert.match(record.runtime[service].containerId,/^[a-f0-9]{12,64}$/);
  assert.match(record.runtime[service].imageId,/^sha256:[a-f0-9]{64}$/);
  assert.equal(record.runtime[service].image,record.images[image]);
}
console.log('Release evidence binds the approved SHA, five running images and synthetic business acceptance');
