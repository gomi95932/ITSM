import assert from 'node:assert/strict';
import { Database } from './apps/api/dist/database.service.js';
import { AuthService } from './apps/api/dist/auth.service.js';
import { DingtalkWebService } from './apps/api/dist/dingtalk-web.service.js';
if(process.env.ITSM_DINGTALK_WEB_CI!=='true'||process.env.NODE_ENV==='production')throw new Error('ISOLATED_FIXTURE_ONLY');
const db=new Database(),auth=new AuthService(db),service=new DingtalkWebService(db,auth),originalFetch=globalThis.fetch;
const employee='dingtalk-web-ci-employee',corp='dingtalk-web-ci-corp';let codeNumber=0,exchanges=0;
Object.assign(process.env,{ENABLE_DINGTALK_WEB_LOGIN:'true',COOKIE_SECURE:'true',ITSM_PUBLIC_URL:'https://help.example.test',
  DINGTALK_CORP_ID:corp,DINGTALK_APP_KEY:'fixture-web-app',DINGTALK_APP_SECRET:'fixture-only-value'});
globalThis.fetch=async(input)=>{
  const url=new URL(String(input));
  if(url.pathname==='/v1.0/oauth2/userAccessToken'){exchanges++;return Response.json({accessToken:'fixture-user-token',corpId:corp});}
  if(url.pathname==='/v1.0/contact/users/me')return Response.json({unionId:'fixture-web-union'});
  if(url.pathname==='/gettoken')return Response.json({errcode:0,access_token:'fixture-app-token'});
  assert.equal(url.pathname,'/topapi/user/getbyunionid');return Response.json({errcode:0,result:{userid:'fixture-web-user'}});
};
const start=async()=>{const result=await service.start();return {...result,query:{state:new URL(result.url).searchParams.get('state'),authCode:`fixture-code-${++codeNumber}`}};};
try{
  await db.pool.query('INSERT INTO employees(id,display_name,active) VALUES($1,$2,true)',[employee,'Browser login fixture']);
  await db.pool.query('INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES($1,$2,$3)',[corp,'fixture-web-user',employee]);
  const first=await start();
  await assert.rejects(service.finish(first.query,'0'.repeat(64)));assert.equal(exchanges,0);
  const concurrent=await Promise.allSettled([service.finish(first.query,first.browser),service.finish(first.query,first.browser)]);
  assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);assert.equal(exchanges,1);
  const session=concurrent.find(result=>result.status==='fulfilled').value;
  const identity=await auth.identity({cookie:`itsm_session=${session.token}`});assert.equal(identity.id,employee);
  await assert.rejects(auth.identity({cookie:`itsm_session=${session.token}`},true));
  await auth.identity({cookie:`itsm_session=${session.token}`,csrf:session.csrfToken},true);
  const expired=await start();await db.pool.query('UPDATE dingtalk_web_login_attempts SET expires_at=now()-interval \'1 second\'');
  await assert.rejects(service.finish(expired.query,expired.browser));assert.equal(exchanges,1);
  const replay=await start();await assert.rejects(service.finish({...replay.query,authCode:first.query.authCode},replay.browser));assert.equal(exchanges,1);
  await db.pool.query('UPDATE employees SET active=false WHERE id=$1',[employee]);
  await assert.rejects(auth.identity({cookie:`itsm_session=${session.token}`}));
  const disabled=await start();await assert.rejects(service.finish(disabled.query,disabled.browser));
  await db.pool.query('UPDATE employees SET active=true WHERE id=$1',[employee]);
  const linked=await start(),linkedSession=await service.finish(linked.query,linked.browser);
  await db.pool.query('DELETE FROM identity_links WHERE corp_id=$1',[corp]);
  await assert.rejects(auth.identity({cookie:`itsm_session=${linkedSession.token}`}));
  const missing=await start();await assert.rejects(service.finish(missing.query,missing.browser));
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM employees WHERE id=$1',[employee])).rows[0].n,1);
  console.log('PASS: browser DingTalk callback race, expiry, code replay, CSRF, inactive identity and session revocation');
}finally{
  globalThis.fetch=originalFetch;
  await db.pool.query('DELETE FROM operational_audits WHERE actor_id=$1',[employee]);
  await db.pool.query('DELETE FROM auth_sessions WHERE employee_id=$1',[employee]);
  await db.pool.query('DELETE FROM identity_links WHERE corp_id=$1',[corp]);
  await db.pool.query('DELETE FROM employees WHERE id=$1',[employee]);
  await db.pool.end();
}
