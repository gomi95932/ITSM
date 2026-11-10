import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IntakePolicyService, intakeDenial } from './intake-policy.service.js';
import type { Database } from './database.service.js';

test('ordinary ingress requires explicit classification and blocks known sensitive material', () => {
  assert.equal(intakeDenial(undefined, { text:'WMS 无法登录' }), 'CONTENT_DECLARATION_REQUIRED');
  assert.equal(intakeDenial('SECURITY_SENSITIVE', { text:'现场需要支持' }), 'SECURITY_CHANNEL_REQUIRED');
  assert.equal(intakeDenial('GENERAL', { text:'WMS 无法登录，请协助重置密码' }), undefined);
  const cases = [
    { fields:{ nested:['sk-' + 'a'.repeat(24)] } },
    { text:'Bearer ' + 'a'.repeat(24) },
    { text:'password=example-placeholder' },
    { text:'密钥：example-placeholder' },
    { text:'-----BEGIN RSA PRIVATE KEY-----' },
    { text:'疑似入侵，请协助排查' },
  ];
  for (const value of cases) assert.equal(intakeDenial('GENERAL', value), 'SECURITY_CHANNEL_REQUIRED');
});

test('blocked content is not reflected or included in metadata-only audits', async () => {
  const queries:unknown[][]=[];
  const db={pool:{query:async (...args:unknown[])=>{queries.push(args);}}} as unknown as Database;
  const policy=new IntakePolicyService(db);
  const payload={contentClass:'GENERAL',text:'password=blocked-intake-sentinel'};
  await assert.rejects(()=>policy.requireGeneral('employee-1',payload,'voice-interpret'), error=>{
    assert.equal(JSON.stringify(error).includes('blocked-intake-sentinel'),false);
    return true;
  });
  assert.equal(queries.length,1);
  assert.deepEqual(queries[0][1],['employee-1','SECURITY_CHANNEL_REQUIRED','voice-interpret']);
  await policy.requireGeneral('employee-1',{contentClass:'GENERAL',text:'WMS 连接失败'},'voice-interpret');
  assert.equal(queries.length,1);
});

test('raw recording stays closed even with old ASR configuration enabled', () => {
  const old=process.env.ASR_DATA_APPROVED;
  try {
    process.env.ASR_DATA_APPROVED='true';
    assert.equal(new IntakePolicyService({} as Database).config().recordingEnabled,false);
  } finally {
    if(old===undefined)delete process.env.ASR_DATA_APPROVED;else process.env.ASR_DATA_APPROVED=old;
  }
});
