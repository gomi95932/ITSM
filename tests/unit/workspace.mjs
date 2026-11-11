import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CALENDAR,serviceMinutes,SLA_TARGETS } from '../../packages/contracts/dist/index.js';
import { AuthService,devEnabled,sessionToken } from '../../apps/api/dist/auth.service.js';

const date=value=>new Date(`${value}+08:00`);
test('SLA counts Shanghai service hours, weekends, holidays and makeup days',()=>{
  assert.equal(serviceMinutes(date('2026-11-06T17:00:00'),date('2026-11-09T10:00:00'),DEFAULT_CALENDAR),120);
  assert.equal(serviceMinutes(date('2026-11-06T17:00:00'),date('2026-11-09T10:00:00'),{...DEFAULT_CALENDAR,holidays:['2026-11-09']}),60);
  assert.equal(serviceMinutes(date('2026-11-07T08:00:00'),date('2026-11-07T19:00:00'),{...DEFAULT_CALENDAR,workdays:['2026-11-07']}),540);
  assert.equal(serviceMinutes(date('2026-11-10T08:00:00'),date('2026-11-10T09:00:00'),DEFAULT_CALENDAR),0);
  assert.equal(serviceMinutes(date('2026-11-10T17:59:30'),date('2026-11-10T18:00:30'),DEFAULT_CALENDAR),0.5);
  assert.equal(serviceMinutes(date('2026-11-07T23:00:00'),date('2026-11-08T01:00:00'),DEFAULT_CALENDAR,true),120);
  assert.equal(SLA_TARGETS.P3.resolution,1080);
  assert.equal(SLA_TARGETS.P4.resolution,2700);
});
test('development identity never works in production and session requires CSRF',async()=>{
  const env={...process.env};
  try{
    process.env.NODE_ENV='production';process.env.ENABLE_DEV_AUTH='true';
    assert.equal(devEnabled(),false);
    const auth=new AuthService({pool:{query:async(sql)=>({rows:sql.startsWith('SELECT employee_id')?[{employee_id:'employee-1',csrf_token:'csrf'}]:sql.startsWith('SELECT id,')?[{id:'employee-1',display_name:'Test'}]:[],rowCount:1})}});
    await assert.rejects(()=>auth.identity({devUser:'agent-1'}));
    const cookie=`itsm_session=${'a'.repeat(64)}`;
    await assert.rejects(()=>auth.identity({cookie},true));
    assert.equal((await auth.identity({cookie,csrf:'csrf'},true)).id,'employee-1');
    assert.equal(sessionToken(`other=1; ${cookie}; x=2`),'a'.repeat(64));
    process.env.NODE_ENV='development';assert.equal(devEnabled(),true);
  }finally{process.env.NODE_ENV=env.NODE_ENV;process.env.ENABLE_DEV_AUTH=env.ENABLE_DEV_AUTH;}
});
