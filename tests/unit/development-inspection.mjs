import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectDevelopment, inspectionDockerInvocation, validateInspectionEvidence,
  validateInspectionSelection, validateMigrationLedger } from '../../scripts/inspect-development.mjs';

const sha='a'.repeat(40),requestId='d'.repeat(32),bundle=`/opt/itsm/releases/${sha}`;
function evidence() {
  const images=Object.fromEntries(['postgres','redis','api','worker','web'].map(name =>
    [name,`ghcr.io/gomi95932/itsm-${name}@sha256:${'b'.repeat(64)}`]));
  const source={repository:'gomi95932/ITSM',runId:123,runAttempt:2,artifactId:456,artifactDigest:`sha256:${'c'.repeat(64)}`};
  const businessAcceptance={status:'passed',runId:'acceptance-run',checks:['fixture-only'],completedAt:'2026-11-18T01:00:00Z'};
  return {sha,requestId,bundle,
    current:{sha,bundlePath:bundle,images:{...images},schemaFingerprint:'fingerprint',verificationLevel:'synthetic-business',businessAcceptance:structuredClone(businessAcceptance)},
    receipt:{...source,sha,requestId,images:{...images},status:'succeeded',phase:'complete',restoreCheck:'isolated-schema-and-ticket-reads',
      completedAt:'2026-11-18T01:01:00Z',businessAcceptance:structuredClone(businessAcceptance)},
    promotion:{...source,sha,bundlePath:bundle,images:{...images},schemaFingerprint:'fingerprint',
      verificationLevel:'approved-root-promoted',deploymentPerformed:false},
    manifest:{sha,images:{...images},runId:'123',runAttempt:2,schemaFingerprint:'fingerprint'}};
}

test('inspection requires exact commit and deployment request identities',() => {
  validateInspectionSelection(sha,requestId);
  for (const value of [undefined,{},'main','a'.repeat(39),sha.toUpperCase(),'../release'])
    assert.throws(() => validateInspectionSelection(value,requestId),/EXACT_INSPECTION_SELECTION_REQUIRED/);
  for (const value of [undefined,{},'d'.repeat(31),requestId.toUpperCase(),'../receipt'])
    assert.throws(() => validateInspectionSelection(sha,value),/EXACT_INSPECTION_SELECTION_REQUIRED/);
});

test('inspection binds all records to one deployed release and source artifact',() => {
  validateInspectionEvidence(evidence());
  const mutations=[
    e => { e.current.sha='e'.repeat(40); },
    e => { e.current.bundlePath='/elsewhere'; },
    e => { e.receipt.requestId='f'.repeat(32); },
    e => { e.receipt.status='failed'; },
    e => { e.receipt.phase='backup'; },
    e => { e.receipt.restoreCheck='not-restored'; },
    e => { e.promotion.deploymentPerformed=true; },
    e => { e.promotion.repository='other/repo'; },
    e => { e.receipt.runId='123'; },
    e => { e.receipt.runAttempt=0; },
    e => { e.receipt.artifactId=Number.MAX_SAFE_INTEGER+1; },
    e => { e.receipt.artifactDigest='unverified'; },
    e => { e.promotion.artifactId=457; },
    e => { e.manifest.runAttempt=1; },
    e => { e.manifest.runId='124'; },
    e => { e.current.schemaFingerprint='other'; },
  ];
  for (const mutate of mutations) {
    const input=structuredClone(evidence()); mutate(input);
    assert.throws(() => validateInspectionEvidence(input),/DEPLOYMENT_EVIDENCE_MISMATCH/);
  }
  for (const record of ['current','receipt','promotion']) for (const service of ['postgres','redis','api','worker','web']) {
    const input=structuredClone(evidence()); input[record].images[service]='wrong-image';
    assert.throws(() => validateInspectionEvidence(input),/DEPLOYMENT_EVIDENCE_MISMATCH/);
  }
});

test('inspection accepts the deployed directory trailing slash without accepting other paths',() => {
  const input=evidence();
  input.current.bundlePath=`${bundle}/`;
  validateInspectionEvidence(input);
  for (const path of [`${bundle}//`,`${bundle}/.`,`${bundle}/../${sha}`,`${bundle}-other/`,null]) {
    input.current.bundlePath=path;
    assert.throws(() => validateInspectionEvidence(input),/DEPLOYMENT_EVIDENCE_MISMATCH/);
  }
});

test('readiness or mismatched acceptance records cannot pass as business acceptance',() => {
  for (const mutate of [
    e => { e.current.verificationLevel='readiness-only'; },
    e => { delete e.current.businessAcceptance; },
    e => { e.current.businessAcceptance.checks=[]; },
    e => { e.current.businessAcceptance.status='failed'; },
    e => { e.receipt.businessAcceptance.runId='another-run'; },
    e => { e.current.businessAcceptance.completedAt='invalid'; },
    e => { e.receipt.completedAt='2026-11-18T00:59:00Z'; },
  ]) {
    const input=structuredClone(evidence()); mutate(input);
    assert.throws(() => validateInspectionEvidence(input),/RECORDED_BUSINESS_ACCEPTANCE_REQUIRED/);
  }
});

test('migration inspection compares the entire name and checksum ledger',() => {
  const rows=[{name:'002_second.sql',checksum:'b'.repeat(64)},{name:'001_first.sql',checksum:'a'.repeat(64)}];
  const manifest={files:[...rows.map(row => ({path:`db/migrations/${row.name}`,sha256:row.checksum})),
    {path:'docs/release-runbook.md',sha256:'c'.repeat(64)}]};
  assert.deepEqual(validateMigrationLedger(manifest,rows),['001_first.sql','002_second.sql']);
  for (const actual of [null,[],rows.slice(1),[...rows,rows[0]],[rows[0],rows[0]],
    [{...rows[0],checksum:'wrong'},rows[1]],[{...rows[0],name:'003_extra.sql'},rows[1]]])
    assert.throws(() => validateMigrationLedger(manifest,actual),/MIGRATION_LEDGER_MISMATCH/);
  assert.throws(() => validateMigrationLedger({files:[]},[]),/MIGRATION_LEDGER_MISMATCH/);
});

test('Docker inspection uses fixed executable, no shell and no inherited remote Docker configuration',() => {
  const args=['container','inspect','a'.repeat(12)],invocation=inspectionDockerInvocation(args);
  assert.deepEqual(invocation,{command:'/usr/bin/docker',args,options:{env:{PATH:'/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8',
    DOCKER_HOST:'unix:///var/run/docker.sock',DOCKER_CONFIG:'/root/.docker'},stdio:['ignore','pipe','pipe']}});
});

test('ordinary accounts cannot inspect private deployment records',async () => {
  if (process.getuid?.() === 0) return;
  await assert.rejects(inspectDevelopment({sha,requestId}),/ROOT_INSPECTION_REQUIRED/);
});
