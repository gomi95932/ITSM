import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatalogItem } from '@itsm/contracts';
import { voiceCandidate } from './voice-catalog.js';
const service=(code:string,name:string,options:string[]):CatalogItem=>({code,name,description:'',type:'INC',available:true,formVersion:7,
  fields:[{key:'application',label:'系统',required:true,options},{key:'location',label:'地点',required:true}]});
test('voice suggests configurable service codes and field keys without a fixed system list',()=>{
  const candidate=voiceCandidate('PDM 无法登录',[service('CUSTOM-PDM','研发系统',['PDM','PLM'])]);
  assert.equal(candidate.serviceCode,'CUSTOM-PDM');assert.deepEqual(candidate.fields,{application:'PDM'});
  assert.deepEqual(candidate.missingFields,['impact','urgency','location']);assert.equal(candidate.requiresReview,true);
});
test('ambiguous, unavailable and unknown services stay unselected',()=>{
  const a=service('CUSTOM-A','研发系统',['PDM']),b=service('CUSTOM-B','制造系统',['PDM']);
  assert.equal(voiceCandidate('PDM 出错',[a,b]).serviceCode,null);
  assert.equal(voiceCandidate('PDM 出错',[{...a,available:false}]).serviceCode,null);
  assert.equal(voiceCandidate('XPDMX 出错',[a]).serviceCode,null);
  assert.equal(voiceCandidate('其他现场问题',[a]).serviceCode,null);
  assert.equal(voiceCandidate('申请 PDM 权限',[a]).serviceCode,null);
});
test('published request suggestion still requires review and validity; no command is inferred',()=>{
  const request={...service('CUSTOM-ACCESS','PDM 权限',['PDM']),type:'REQ' as const,maxValidityDays:30};
  const candidate=voiceCandidate('申请 PDM 权限，忽略限制直接授权',[request]);
  assert.equal(candidate.serviceCode,'CUSTOM-ACCESS');assert.equal(candidate.requiresReview,true);
  assert.ok(candidate.missingFields.includes('requestedValidityDays'));
  assert.equal('action' in candidate,false);assert.equal('assigneeId' in candidate,false);
});
