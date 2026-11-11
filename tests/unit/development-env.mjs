import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script=fileURLToPath(new URL('../../scripts/create-development-env.mjs',import.meta.url));
test('development configuration is private, random and never overwritten',async () => {
  const directory=await mkdtemp(resolve(tmpdir(),'itsm-env-'));
  const create=(...args) => spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
  try {
    const first=resolve(directory,'first.env'), second=resolve(directory,'second.env');
    const result=create(first);
    assert.equal(result.status,0);
    const contents=await readFile(first,'utf8');
    assert.equal((await stat(first)).mode & 0o777,0o600);
    const values=Object.fromEntries(contents.trim().split('\n').map(line=>line.split('=')));
    for (const key of ['ITSM_DB_PASSWORD','ITSM_REDIS_PASSWORD']) {
      assert.match(values[key],/^[a-f0-9]{64}$/);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(values[key]));
    }
    assert.notEqual(values.ITSM_DB_PASSWORD,values.ITSM_REDIS_PASSWORD);
    assert.equal(values.ITSM_SEED_DEV_DATA,'false');
    assert.equal(values.NOTIFICATION_MODE,'fake');
    assert.equal(values.ENABLE_LIVE_NOTIFICATIONS,'false');
    assert.notEqual(create(first,'--seed-development-fixtures').status,0);
    assert.equal(await readFile(first,'utf8'),contents);
    assert.equal(create(second,'--seed-development-fixtures').status,0);
    const seeded=await readFile(second,'utf8');
    assert.match(seeded,/^ITSM_SEED_DEV_DATA=true$/m);
    for (const key of ['ITSM_DB_PASSWORD','ITSM_REDIS_PASSWORD'])
      assert.ok(!seeded.includes(values[key]));
    assert.notEqual(create(resolve(directory,'invalid.env'),'--invalid').status,0);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
