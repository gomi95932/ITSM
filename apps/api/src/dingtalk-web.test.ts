import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { dingtalkWebSettings } from './dingtalk-web-config.js';
import { DingtalkWebService } from './dingtalk-web.service.js';
import { DingtalkWebController } from './dingtalk-web.controller.js';
import type { Response as ExpressResponse } from 'express';
const env={ENABLE_DINGTALK_WEB_LOGIN:'true',COOKIE_SECURE:'true',ITSM_PUBLIC_URL:'https://help.example.test',
  DINGTALK_CORP_ID:'fixture-corp',DINGTALK_APP_KEY:'fixture-app',DINGTALK_APP_SECRET:'fixture-only-value'};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
test('browser DingTalk login requires explicit HTTPS configuration and a fixed callback',()=>{
  assert.equal(dingtalkWebSettings(env)?.redirectUri,'https://help.example.test/api/v1/auth/dingtalk-web/callback');
  for(const changed of [{ENABLE_DINGTALK_WEB_LOGIN:'false'},{COOKIE_SECURE:'false'},{DINGTALK_APP_KEY:''},
    {ITSM_PUBLIC_URL:'http://help.example.test'},{ITSM_PUBLIC_URL:'https://help.example.test/path'},
    {ITSM_PUBLIC_URL:'https://user:pass@help.example.test'},{ITSM_PUBLIC_URL:'https://help.example.test?redirect=other'},
    {DINGTALK_CORP_ID:' fixture-corp'}])assert.equal(dingtalkWebSettings({...env,...changed}),undefined);
});
test('browser login binds state, enterprise and existing employee; codes and attempts are single-use',async()=>{
  const previous={...process.env},originalFetch=globalThis.fetch;Object.assign(process.env,env);
  let attempt:{state:string;browser:string;configuration:string}|undefined,usedCode=false,sessions=0,linked=true;
  let providerCorp='fixture-corp',providerFailure=false,exchanges=0;
  const client={query:async(sql:string,values:string[])=>{
    if(sql.includes('INSERT INTO dingtalk_web_login_attempts'))attempt={state:values[0],browser:values[1],configuration:values[2]};
    if(sql.includes('JOIN identity_links')){
      assert.ok(sql.includes('e.active=true FOR SHARE OF e,l'));assert.deepEqual(values,['fixture-corp','verified-user']);
      return {rowCount:linked?1:0,rows:linked?[{id:'fixture-employee'}]:[]};
    }
    if(sql.includes('INSERT INTO auth_sessions')){sessions++;assert.equal(values[2],'fixture-employee');}
    assert.ok(!/INSERT INTO employees|UPDATE employees|INSERT INTO identity_links/.test(sql));
    return {rowCount:1,rows:[]};
  }};
  const db={transaction:async(fn:(c:unknown)=>Promise<unknown>)=>fn(client),pool:{query:async(sql:string,values:string[])=>{
    if(sql.includes('DELETE FROM dingtalk_web_login_attempts')){
      assert.ok(sql.includes('expires_at>now()'));
      if(!attempt||attempt.state!==values[0]||attempt.browser!==values[1]||attempt.configuration!==values[2])return {rowCount:0,rows:[]};
      attempt=undefined;return {rowCount:1,rows:[{}]};
    }
    assert.ok(sql.includes('INSERT INTO auth_code_uses'));if(usedCode)return {rowCount:0,rows:[]};usedCode=true;
    return {rowCount:1,rows:[{}]};
  }}} as unknown as Database;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(init?.redirect,'error');
    if(url.pathname==='/v1.0/oauth2/userAccessToken'){
      exchanges++;assert.deepEqual(JSON.parse(String(init?.body)),{clientId:'fixture-app',clientSecret:'fixture-only-value',code:'fixture-code',grantType:'authorization_code'});
      return providerFailure?new Response('{}',{status:503}):Response.json({accessToken:'fixture-user-token',corpId:providerCorp});
    }
    if(url.pathname==='/v1.0/contact/users/me'){
      assert.deepEqual(init?.headers,{'x-acs-dingtalk-access-token':'fixture-user-token'});return Response.json({unionId:'verified-union'});
    }
    if(url.pathname==='/gettoken'){assert.equal(url.searchParams.get('appkey'),'fixture-app');return Response.json({errcode:0,access_token:'fixture-app-token'});}
    assert.equal(url.pathname,'/topapi/user/getbyunionid');assert.deepEqual(JSON.parse(String(init?.body)),{unionid:'verified-union'});
    return Response.json({errcode:0,result:{userid:'verified-user'}});
  };
  try{
    const service=new DingtalkWebService(db,new AuthService(db));
    const start=async()=>{usedCode=false;const result=await service.start();const url=new URL(result.url);
      assert.equal(url.origin,'https://login.dingtalk.com');assert.equal(url.searchParams.get('scope'),'openid corpid');
      assert.equal(url.searchParams.get('redirect_uri'),dingtalkWebSettings(env)?.redirectUri);
      assert.notEqual(attempt!.browser,result.browser);assert.equal(attempt!.browser,hash(result.browser));
      return {browser:result.browser,state:url.searchParams.get('state')!};};
    const first=await start();
    await assert.rejects(service.finish({state:first.state,authCode:'fixture-code'},'b'.repeat(64)));assert.equal(exchanges,0);
    await assert.rejects(service.finish({state:[first.state],authCode:'fixture-code'},first.browser));assert.equal(exchanges,0);
    const result=await service.finish({state:first.state,authCode:'fixture-code'},first.browser);assert.equal(result.token.length,64);assert.equal(sessions,1);
    await assert.rejects(service.finish({state:first.state,authCode:'fixture-code'},first.browser));assert.equal(sessions,1);
    const replay=await start();usedCode=true;await assert.rejects(service.finish({state:replay.state,authCode:'fixture-code'},replay.browser));assert.equal(exchanges,1);
    const other=await start();providerCorp='other-corp';await assert.rejects(service.finish({state:other.state,authCode:'fixture-code'},other.browser));assert.equal(sessions,1);providerCorp='fixture-corp';
    const unlinked=await start();linked=false;await assert.rejects(service.finish({state:unlinked.state,authCode:'fixture-code'},unlinked.browser));assert.equal(sessions,1);linked=true;
    const changed=await start();process.env.DINGTALK_APP_SECRET='rotated-fixture';await assert.rejects(service.finish({state:changed.state,authCode:'fixture-code'},changed.browser));process.env.DINGTALK_APP_SECRET=env.DINGTALK_APP_SECRET;
    const denied=await start();await assert.rejects(service.finish({state:denied.state,error:'access_denied'},denied.browser));assert.equal(attempt,undefined);
    const unavailable=await start();providerFailure=true;await assert.rejects(service.finish({state:unavailable.state,authCode:'fixture-code'},unavailable.browser));assert.equal(sessions,1);
  }finally{globalThis.fetch=originalFetch;for(const key of Object.keys(env)){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
test('callback clears transient cookies, hides error details and rejects duplicate browser cookies',async()=>{
  let received:string|undefined,fail=false;
  const service={finish:async(_query:unknown,browser?:string)=>{received=browser;if(fail||!browser)throw new Error('private-provider-details');return {token:'a'.repeat(64)};}} as unknown as DingtalkWebService;
  const controller=new DingtalkWebController(service),headers:Record<string,unknown>={};let destination='';
  const res={setHeader:(key:string,value:unknown)=>{headers[key]=value;},redirect:(code:number,url:string)=>{assert.equal(code,303);destination=url;}} as ExpressResponse;
  await controller.callback({},'__Secure-itsm_dingtalk_web=one',res);
  assert.equal(destination,'/');assert.equal(headers['Cache-Control'],'no-store');
  await controller.callback({},'__Secure-itsm_dingtalk_web=one; __Secure-itsm_dingtalk_web=two',res);assert.equal(received,undefined);assert.equal(destination,'/?login=failed');
  fail=true;await controller.callback({},'__Secure-itsm_dingtalk_web=one',res);assert.equal(destination,'/?login=failed');
  assert.match(String(headers['Set-Cookie']),/Max-Age=0; Secure/);assert.equal(headers['Referrer-Policy'],'no-referrer');
});
