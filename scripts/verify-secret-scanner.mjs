import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('DISPOSABLE_GITHUB_CI_ONLY');

// The canary is generated in memory, never stored in Git, files, or scanner output.
const canary = `ghp_${randomBytes(18).toString('hex')}`;
const scan = input => spawnSync('gitleaks', ['stdin', '--redact=100', '--no-banner', '--no-color', '--exit-code', '1'], {
  input, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
});
const positive = scan(`github_token = "${canary}"\n`);
const negative = scan('const label = "synthetic test without credentials";\n');
if (positive.status !== 1 || negative.status !== 0 || positive.error || negative.error
  || `${positive.stdout}${positive.stderr}`.includes(canary)) throw new Error('SECRET_SCANNER_SELF_TEST_FAILED');
console.log('Secret scanner rejected an ephemeral canary, accepted a clean fixture, and redacted the secret');

const reviewed = JSON.parse(readFileSync('infra/security/reviewed-secret-fixtures.json', 'utf8'));
if (!process.env.RUNNER_TEMP || !Array.isArray(reviewed)) throw new Error('INVALID_REVIEWED_FIXTURES');
const fingerprints = new Set();
for (const finding of reviewed) {
  const expiry = Date.parse(`${finding.expiresAt}T00:00:00Z`);
  if (!/^[a-f0-9]{40}:tests\/integration\/[a-z0-9-]+\.mjs:generic-api-key:[1-9]\d*$/.test(finding.fingerprint)
    || !finding.owner || !finding.reason || !/^\d{4}-\d{2}-\d{2}$/.test(finding.reviewedAt)
    || !/^\d{4}-\d{2}-\d{2}$/.test(finding.expiresAt) || !Number.isFinite(expiry) || expiry <= Date.now()
    || fingerprints.has(finding.fingerprint)) throw new Error('INVALID_OR_EXPIRED_REVIEWED_FIXTURE');
  fingerprints.add(finding.fingerprint);
}
writeFileSync(join(process.env.RUNNER_TEMP, 'itsm-gitleaks-ignore'), [...fingerprints].join('\n') + '\n', { mode: 0o600 });
console.log(`Prepared ${fingerprints.size} exact, unexpired historical test-fixture fingerprints`);
