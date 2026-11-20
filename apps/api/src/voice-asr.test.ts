import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceAsrService,transcribeVoice,voiceConfiguration,voiceInput } from './voice-asr.service.js';
import { WorkspaceController } from './workspace.controller.js';
import { IntakePolicyService } from './intake-policy.service.js';
import type { Database } from './database.service.js';
import type { AuthService } from './auth.service.js';
import { IntakeInterpreterService } from './intake-interpreter.service.js';

const approved={ENABLE_VOICE_ASR:'true',VOICE_ASR_DATA_BOUNDARY:'internal-approved',VOICE_ASR_APPROVAL_REF:'ci-fixture-only',
  VOICE_ASR_MODEL:'ci-model',VOICE_ASR_TOKEN:'ci-placeholder',VOICE_ASR_ENDPOINT:'https://asr.internal/v1/audio/transcriptions'};
const input={audio:'YQ==',mimeType:'audio/webm',consent:true,contentClass:'GENERAL'};
test('recording requires complete explicit internal data-path configuration',()=>{
  assert.equal(voiceConfiguration({}),undefined);
  assert.equal(voiceConfiguration({ASR_DATA_APPROVED:'true'}),undefined);
  assert.ok(voiceConfiguration(approved));
  for(const key of Object.keys(approved))assert.equal(voiceConfiguration({...approved,[key]:''}),undefined,key);
  for(const endpoint of ['http://asr.internal/v1/audio/transcriptions','https://u:p@asr.internal/v1/audio/transcriptions',
    'https://asr.internal/v1/audio/transcriptions?token=bad','https://asr.internal/v1/audio/transcriptions#fragment','not-a-url']){
    assert.equal(voiceConfiguration({...approved,VOICE_ASR_ENDPOINT:endpoint}),undefined);
  }
  assert.equal(voiceConfiguration({...approved,VOICE_ASR_TOKEN:'value\nInjected: true'}),undefined);
});
test('audio declaration, consent, canonical base64, format and size are checked',()=>{
  assert.deepEqual(voiceInput(input),input);
  for(const body of [null,[],{}, {...input,consent:false},{...input,contentClass:'SECURITY_SENSITIVE'},
    {...input,audio:'YR=='},{...input,audio:'YQ==\n'},{...input,audio:'a'.repeat(2_666_672)},
    {...input,mimeType:'video/mp4'},{...input,url:'https://example.invalid'}, {...input,audio:''}]){
    assert.throws(()=>voiceInput(body),/Bad Request/);
  }
});
test('transcription uses a fixed multipart contract and forbids redirects',async()=>{
  const text=await transcribeVoice(voiceConfiguration(approved)!,Buffer.from('fixture'),async(url,options)=>{
    assert.equal(url,approved.VOICE_ASR_ENDPOINT);assert.equal(options?.redirect,'error');
    assert.equal((options?.headers as Record<string,string>).Authorization,'Bearer ci-placeholder');
    const form=options?.body as FormData;
    assert.equal(form.get('model'),'ci-model');assert.equal(form.get('language'),'zh');assert.equal(form.get('response_format'),'json');
    const file=form.get('file') as File;assert.equal(file.type,'audio/wav');assert.equal(file.name,'recording.wav');
    assert.equal(await file.text(),'fixture');
    return Response.json({text:'  WMS 无法登录  '});
  });
  assert.equal(text,'WMS 无法登录');
});
test('provider failures, oversized or invalid responses return safe errors only',async()=>{
  for(const response of [new Response('provider-private-detail',{status:500}),new Response('not-json'),
    Response.json({text:''}),Response.json({text:[]}),Response.json({text:'a'.repeat(4001)}),
    Response.json({text:'normal',padding:'a'.repeat(17000)})]){
    await assert.rejects(()=>transcribeVoice(voiceConfiguration(approved)!,Buffer.from('fixture'),async()=>response),error=>{
      assert.equal(JSON.stringify(error).includes('provider-private-detail'),false);
      assert.match(JSON.stringify(error),/ASR_UNAVAILABLE/);return true;
    });
  }
  await assert.rejects(()=>transcribeVoice(voiceConfiguration(approved)!,Buffer.from('fixture'),async()=>{throw new Error('private-token');}),error=>{
    assert.equal(JSON.stringify(error).includes('private-token'),false);return true;
  });
});
test('voice ingress authenticates, screens declarations before ASR and screens results before return',async()=>{
  const queries:unknown[][]=[];let calls=0;
  const db={pool:{query:async(...args:unknown[])=>{queries.push(args);return {rows:[{count:1}]};}}} as unknown as Database;
  const identity={identity:async()=>({id:'employee-1'})} as unknown as AuthService;
  const voice={config:()=>({recordingEnabled:true}),transcribe:async()=>{calls++;return {text:'password=blocked-transcript-sentinel'};}} as unknown as VoiceAsrService;
  const controller=new WorkspaceController(db,identity,new IntakePolicyService(db),voice,new IntakeInterpreterService());
  await assert.rejects(()=>controller.transcribe({}, {...input,contentClass:'SECURITY_SENSITIVE'}));assert.equal(calls,0);
  await assert.rejects(()=>controller.transcribe({},input),error=>{
    assert.equal(JSON.stringify(error).includes('blocked-transcript-sentinel'),false);return true;
  });
  assert.equal(calls,1);assert.equal(JSON.stringify(queries).includes('blocked-transcript-sentinel'),false);
  const denied=new WorkspaceController(db,{identity:async()=>{throw new Error('IDENTITY_REQUIRED');}} as unknown as AuthService,new IntakePolicyService(db),voice,new IntakeInterpreterService());
  await assert.rejects(()=>denied.transcribe({},input),/IDENTITY_REQUIRED/);assert.equal(calls,1);
});
test('an identity revoked while transcription is pending cannot receive the result',async()=>{
  let checks=0;
  const db={pool:{query:async()=>({rows:[{count:1}]})}} as unknown as Database;
  const identity={identity:async()=>{if(++checks>1)throw new Error('IDENTITY_REVOKED');return {id:'employee-1'};}} as unknown as AuthService;
  const voice={config:()=>({recordingEnabled:true}),transcribe:async()=>({text:'WMS 页面打开失败'})} as unknown as VoiceAsrService;
  const controller=new WorkspaceController(db,identity,new IntakePolicyService(db),voice,new IntakeInterpreterService());
  await assert.rejects(()=>controller.transcribe({},input),/IDENTITY_REVOKED/);assert.equal(checks,2);
});
