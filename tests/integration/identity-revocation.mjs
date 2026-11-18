import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const compose = ['compose', '--project-name', 'itsm-dev', '--env-file', process.env.ITSM_CI_ENV,
  '-f', 'infra/compose/compose.yaml'];
async function sql(query) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [...compose, 'exec', '-T', 'db', 'sh', '-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"', 'sh', query],
    { stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('IDENTITY_FIXTURE_SQL_FAILED')));
  });
}

const subject = 'identity-revocation-first';
const control = 'identity-revocation-second';
const corp = 'corp-ci-revocation';
const firstLink = 'ci-ding-first';
const secondLink = 'ci-ding-second';
const addLink = (employee, dingUser) =>
  `INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES ('${corp}','${dingUser}','${employee}')`;
const subjectLink = `corp_id='${corp}' AND employee_id='${subject}'`;
const disable = `UPDATE employees SET active=false WHERE id='${subject}'`;
const enable = `UPDATE employees SET active=true WHERE id='${subject}'`;
const remove = `DELETE FROM identity_links WHERE ${subjectLink}`;

async function session(employee) {
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  const csrf = randomBytes(24).toString('hex');
  await sql(`INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at)
    VALUES ('${hash}','${csrf}','${employee}',now()+interval '1 hour')`);
  return { cookie: `itsm_session=${token}`, 'x-csrf-token': csrf };
}

async function auth(path, headers, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:8088/api/v1/auth/${path}`, {
    method, headers, signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

await sql(`INSERT INTO employees(id,display_name) VALUES ('${subject}','First identity'),('${control}','Second identity');
  ${addLink(subject, firstLink)}; ${addLink(control, secondLink)}`);
try {
  const controlSession = await session(control);

  async function verifyRevocation(change, restore) {
    const activeSession = await session(subject);
    const otherDevice = await session(subject);
    assert.equal((await auth('me', activeSession)).body.id, subject);
    assert.equal((await auth('logout', { ...activeSession, 'x-csrf-token': 'wrong' }, 'POST')).status, 403);
    await sql(`BEGIN; ${change}; ROLLBACK`);
    assert.equal((await auth('me', activeSession)).body.id, subject, 'rollback preserves the current session');
    await sql(change);
    assert.equal((await auth('me', activeSession)).status, 401);
    assert.equal((await auth('logout', otherDevice, 'POST')).status, 401, 'revoked session cannot authorize a write');
    await sql(restore);
    assert.equal((await auth('me', activeSession)).status, 401, 'reenabling an identity must not revive an old session');
    assert.equal((await auth('me', controlSession)).body.id, control, 'unrelated employees keep their sessions');
  }

  await verifyRevocation(disable, enable);
  await verifyRevocation(remove, addLink(subject, firstLink));
  await verifyRevocation(`UPDATE identity_links SET ding_user_id='ci-ding-reissued' WHERE ${subjectLink}`,
    `UPDATE identity_links SET ding_user_id='${firstLink}' WHERE ${subjectLink}`);

  const fresh = await session(subject);
  await sql(`UPDATE identity_links SET ding_user_id=ding_user_id WHERE ${subjectLink}`);
  assert.equal((await auth('me', fresh)).body.id, subject, 'an unchanged directory synchronization keeps current sessions');
  assert.equal((await auth('logout', fresh, 'POST')).status, 200);
  assert.equal((await auth('me', fresh)).status, 401);
  console.log('Session revocation verified: transactional disable, unlink, remap, reactivation, CSRF and unrelated accounts');
} finally {
  await sql(`DELETE FROM identity_links WHERE corp_id='${corp}';
    DELETE FROM auth_sessions WHERE employee_id IN ('${subject}','${control}');
    DELETE FROM employees WHERE id IN ('${subject}','${control}')`);
}
