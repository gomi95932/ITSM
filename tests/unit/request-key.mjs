import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../../apps/web/src/request-key.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { createRequestKey } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('request keys prefer native UUID generation with its receiver intact', () => {
  const crypto = {
    randomUUID() { assert.equal(this, crypto); return 'native-uuid'; },
    getRandomValues() { assert.fail('native generation should be preferred'); },
  };
  assert.equal(createRequestKey(crypto), 'native-uuid');
});

test('LAN HTTP fallback generates version 4 UUIDs using secure random bytes', () => {
  let calls = 0;
  const crypto = {
    getRandomValues(bytes) {
      assert.equal(this, crypto);
      assert.equal(bytes.length, 16);
      calls++;
      return bytes.fill(255);
    },
  };
  assert.equal(createRequestKey(crypto), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
  const keys = new Set(Array.from({ length: 1000 }, () => createRequestKey({
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  })));
  assert.equal(keys.size, 1000);
  for (const key of keys) assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('request keys never silently fall back to weak random values', () => {
  assert.throws(() => createRequestKey({}), /SECURE_RANDOM_UNAVAILABLE/);
  assert.throws(() => createRequestKey(null), /SECURE_RANDOM_UNAVAILABLE/);
  assert.throws(() => createRequestKey({ getRandomValues() { throw new Error('entropy failure'); } }), /entropy failure/);
});
