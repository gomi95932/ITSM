import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enterpriseConfig, enterpriseEvidence } from '../fixtures/enterprise-uat.mjs';
import { validateEnterpriseUatConfig, verifyEnterpriseUat } from '../../scripts/verify-enterprise-uat.mjs';
import { main, validateEnterpriseReadinessEvidence } from '../../scripts/release.mjs';

const hash='f'.repeat(64),instant=Date.parse('2026-11-15T03:00:00.000Z');
function response(url) {
  if(url.endsWith('/auth/me'))return new Response('{}',{status:401});
  if(url.endsWith('/auth/config'))return Response.json({mode:'dingtalk',configured:true,corpId:'fixture-corp'});
  if(url.endsWith('/health/ready'))return Response.json({status:'ok',service:'itsm-api'});
  assert.equal(url,'https://itsm.example.test/');
  return new Response('<html><div id="app"></div></html>');
}

test('enterprise configuration requires production identity, secure cookies, no seeds and consistent app settings',()=>{
  const result=validateEnterpriseUatConfig(enterpriseConfig());
  assert.equal(result.publicUrl,'https://itsm.example.test');
  assert.deepEqual(result.modules,enterpriseEvidence().modules);
  for(const [service,key,value] of [
    ['api','ENABLE_DEV_AUTH','true'],['api','COOKIE_SECURE','false'],['api','NODE_ENV','development'],
    ['worker','NODE_ENV','development'],['migrate','ITSM_SEED_DEV_DATA','true'],['migrate','NODE_ENV','development'],
    ['api','NOTIFICATION_MODE','fake'],['worker','NOTIFICATION_MODE','fake'],
    ['worker','DINGTALK_APP_SECRET','other'],['api','DINGTALK_CORP_ID',''],['worker','ENABLE_LIVE_NOTIFICATIONS','1'],
    ['worker','DINGTALK_AGENT_ID','not-an-agent'],['worker','DINGTALK_DIRECTORY_ROOTS',''],
    ['worker','DINGTALK_DIRECTORY_ROOTS','11,12,13'],['worker','ENABLE_DIRECTORY_SYNC','false'],
    ['api','ENABLE_REQUEST_INTAKE','true-ish'],['api','REQUEST_INTAKE_CATALOG_VERSIONS',''],
    ['api','ENABLE_VOICE_ASR','1'],['api','ENABLE_INTAKE_AI','1'],
  ]){
    const config=enterpriseConfig();config.services[service].environment[key]=value;
    assert.throws(()=>validateEnterpriseUatConfig(config),/ENTERPRISE_/);
  }
  const noOA=enterpriseConfig();for(const service of ['api','worker'])noOA.services[service].environment.ENABLE_LIVE_OA_APPROVAL='false';
  assert.throws(()=>validateEnterpriseUatConfig(noOA),/ENTERPRISE_REQUEST_CONFIG_REQUIRED/);
  for(const value of ['http://itsm.example.test','https://localhost','https://127.0.0.1','https://[::1]',
    'https://user:password@itsm.example.test','https://itsm.example.test/path','https://itsm.example.test/?token=fixture','https://itsm.example.test/#token']){
    const config=enterpriseConfig();config.services.worker.environment.ITSM_PUBLIC_URL=value;
    assert.throws(()=>validateEnterpriseUatConfig(config),/ENTERPRISE_HTTPS_ENTRY_REQUIRED/);
  }
});

test('enabled voice and interpreter require approved internal HTTPS adapters; disabled modules remain visible',()=>{
  for(const [flag,prefix,path] of [['ENABLE_VOICE_ASR','VOICE_ASR','/audio/transcriptions'],['ENABLE_INTAKE_AI','INTAKE_AI','/chat/completions']]){
    const config=enterpriseConfig(),api=config.services.api.environment;
    api[flag]='true';Object.assign(api,{[`${prefix}_DATA_BOUNDARY`]:'internal-approved',[`${prefix}_APPROVAL_REF`]:'fixture-approval',
      [`${prefix}_TOKEN`]:'fixture-model-token',[`${prefix}_MODEL`]:'fixture-model',[`${prefix}_ENDPOINT`]:`https://model.example.test/v1${path}`});
    assert.doesNotThrow(()=>validateEnterpriseUatConfig(config));
    for(const [key,value] of [[`${prefix}_DATA_BOUNDARY`,'public'],[`${prefix}_APPROVAL_REF`,''],[`${prefix}_TOKEN`,''],
      [`${prefix}_MODEL`,''],[`${prefix}_ENDPOINT`,`http://model.example.test/v1${path}`],
      [`${prefix}_ENDPOINT`,`https://model.example.test/v1${path}?token=fixture`],[`${prefix}_ENDPOINT`,'https://model.example.test/wrong']]){
      const changed=structuredClone(config);changed.services.api.environment[key]=value;
      assert.throws(()=>validateEnterpriseUatConfig(changed),/ENTERPRISE_MODEL_CONFIG_REQUIRED/);
    }
  }
  const config=enterpriseConfig();
  for(const service of ['api','worker'])for(const flag of ['ENABLE_DIRECTORY_SYNC','ENABLE_LIVE_OA_APPROVAL','ENABLE_MANUAL_REQUEST_DELIVERY'])config.services[service].environment[flag]='false';
  config.services.api.environment.ENABLE_REQUEST_INTAKE='false';config.services.worker.environment.ENABLE_LIVE_NOTIFICATIONS='false';
  assert.ok(Object.values(validateEnterpriseUatConfig(config).modules).every(value=>value===false));
});

test('enterprise readiness only performs bounded GETs and records pending user acceptance',async()=>{
  const calls=[];
  const report=await verifyEnterpriseUat({config:enterpriseConfig(),port:8088,configurationSha256:hash,now:()=>instant,
    fetchImpl:async(url,options)=>{calls.push({url,options});return response(url);}});
  validateEnterpriseReadinessEvidence(report,hash);
  assert.equal(report.userAcceptance,'pending');assert.equal(report.completedAt,new Date(instant).toISOString());
  assert.equal(calls.length,8);assert.equal(calls.filter(call=>call.options.headers['x-dev-user']).length,2);
  for(const {options} of calls){assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);}
  assert.equal(JSON.stringify(report).includes('fixture-app-secret'),false);
});

test('readiness rejects identity bypasses and malformed, oversized, failed or redirected endpoints',async()=>{
  for(const [target,make,error] of [
    ['/health/ready',()=>Response.json(null),'ENTERPRISE_READINESS_FAILED'],
    ['/auth/config',()=>Response.json(null),'ENTERPRISE_AUTH_RUNTIME_MISMATCH'],
    ['/auth/config',()=>Response.json({mode:'development',configured:true,corpId:'fixture-corp'}),'ENTERPRISE_AUTH_RUNTIME_MISMATCH'],
    ['/auth/config',()=>Response.json({mode:'dingtalk',configured:true,corpId:'another-corp'}),'ENTERPRISE_AUTH_RUNTIME_MISMATCH'],
    ['/auth/config',()=>new Response('{'),'ENTERPRISE_READINESS_RESPONSE_INVALID'],
    ['/auth/config',()=>new Response('x'.repeat(65537)),'ENTERPRISE_READINESS_RESPONSE_INVALID'],
    ['/auth/me',()=>new Response('{}'),'ENTERPRISE_ANONYMOUS_BOUNDARY_FAILED'],
    ['https://itsm.example.test/api/v1/auth/me',()=>new Response('{}'),'ENTERPRISE_ANONYMOUS_BOUNDARY_FAILED'],
    ['https://itsm.example.test/',()=>new Response('wrong app'),'ENTERPRISE_HTTPS_WEB_FAILED'],
    ['/health/ready',()=>new Response('',{status:503}),'ENTERPRISE_READINESS_RESPONSE_INVALID'],
    ['/health/ready',()=>{throw new Error('private error');},'ENTERPRISE_READINESS_UNREACHABLE'],
    ['https://itsm.example.test/',()=>new Response(new ReadableStream({
      start(controller){controller.error(new Error('private transport detail'));},
    })),'ENTERPRISE_READINESS_RESPONSE_INVALID'],
  ]){
    await assert.rejects(verifyEnterpriseUat({config:enterpriseConfig(),port:8088,configurationSha256:hash,
      fetchImpl:async url=>(target.startsWith('https:')?url===target:url.endsWith(target))?make():response(url)}),new RegExp(error));
  }
  for(const port of [0,65536,'8088'])await assert.rejects(verifyEnterpriseUat({config:enterpriseConfig(),port,configurationSha256:hash}),/SELECTION_REQUIRED/);
});

test('readiness evidence cannot be promoted into real acceptance or attached to a different configuration',()=>{
  validateEnterpriseReadinessEvidence(enterpriseEvidence(),hash);
  for(const change of [e=>{e.kind='business';},e=>{e.userAcceptance='passed';},e=>{e.configurationSha256='e'.repeat(64);},
    e=>{e.checks.pop();},e=>{e.checks[0]=e.checks[1];},e=>{e.modules.voice='true';},e=>{e.runId='arbitrary';},e=>{e.completedAt='invalid';}]){
    const evidence=enterpriseEvidence();change(evidence);
    assert.throws(()=>validateEnterpriseReadinessEvidence(evidence,hash),/ENTERPRISE_READINESS_EVIDENCE_REQUIRED/);
  }
});

test('release rejects mixed verification modes, repeated flags and enterprise verification on backups',async()=>{
  for(const args of [['deploy','a'.repeat(40),'--verify-development','--verify-enterprise-uat'],
    ['backup','--verify-enterprise-uat'],['restore-check','--verify-enterprise-uat']])
    await assert.rejects(main(args),/INVALID_RELEASE_COMMAND/);
  await assert.rejects(main(['deploy','a'.repeat(40),'--verify-enterprise-uat','--verify-enterprise-uat']),/INVALID_RELEASE_ARGUMENT/);
});
