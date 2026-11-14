import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
