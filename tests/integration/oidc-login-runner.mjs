import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import * as oidc from 'openid-client';
import {Database} from './apps/api/dist/database.service.js';
import {AuthService} from './apps/api/dist/auth.service.js';
import {OidcService} from './apps/api/dist/oidc.service.js';
import {OidcController} from './apps/api/dist/oidc.controller.js';
if(process.env.ITSM_OIDC_CI!=='true'||process.env.NODE_ENV==='production')throw new Error('ISOLATED_FIXTURE_ONLY');
const db=new Database(),auth=new AuthService(db),service=new OidcService(db,auth),controller=new OidcController(service);
const issuer='https://oidc-fixture.example.test',employee='oidc-ci-employee',control='oidc-ci-control';
Object.assign(process.env,{ENABLE_OIDC_LOGIN:'true',COOKIE_SECURE:'true',OIDC_ISSUER:issuer,OIDC_CLIENT_ID:'itsm-ci',
  OIDC_CLIENT_SECRET:'fixture-only-value',ITSM_PUBLIC_URL:'https://help.example.test'});
const redirectUri='https://help.example.test/api/v1/auth/oidc/callback';
const hash=value=>createHash('sha256').update(value).digest('hex');
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const config=new oidc.Configuration({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`},'itsm-ci','fixture-only-value');
oidc.enableNonRepudiationChecks(config);
let nonce='',subject='verified-ci-subject',exchangeCount=0;
config[oidc.customFetch]=async input=>{
  if(String(input)===`${issuer}/jwks`)return Response.json({keys:[{...keys.publicKey.export({format:'jwk'}),kid:'ci',use:'sig',alg:'RS256'}]});
  assert.equal(String(input),`${issuer}/token`);exchangeCount++;
  const value=[{alg:'RS256',kid:'ci'},{iss:issuer,sub:subject,aud:'itsm-ci',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,nonce}]
    .map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return Response.json({token_type:'Bearer',access_token:'fixture-only-value',id_token:`${value}.${sign('RSA-SHA256',Buffer.from(value),keys.privateKey).toString('base64url')}`});
};
service.configuration=async()=>config;
async function attempt(options={}){
  const state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('hex');nonce=randomBytes(24).toString('hex');
  await db.pool.query(`INSERT INTO oidc_login_attempts(state_hash,browser_hash,issuer,client_id,redirect_uri,verifier,nonce,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::interval)`,[hash(state),hash(browser),issuer,options.clientId??'itsm-ci',redirectUri,'v'.repeat(43),nonce,options.expired?'-1 minute':'5 minutes']);
  return {state,browser,code:'fixture-code'};
}
const finish=a=>service.finish({state:a.state,code:a.code},a.browser);
async function sessionFor(id){return db.transaction(client=>auth.issueSession(client,id));}
try{
  await db.pool.query('INSERT INTO employees(id,display_name) VALUES($1,$1),($2,$2)',[employee,control]);
  await db.pool.query('INSERT INTO oidc_identity_links(issuer,subject,employee_id,approval_ref) VALUES($1,$2,$3,$4)',[issuer,subject,employee,'CI-FIXTURE']);
  const start=await service.start();const startUrl=new URL(start.url);
  assert.equal(startUrl.searchParams.get('code_challenge_method'),'S256');assert.equal(startUrl.searchParams.get('redirect_uri'),redirectUri);
  assert.equal(start.browser.length,64);assert.equal(startUrl.searchParams.get('scope'),'openid');
  for(const options of [{expired:true},{clientId:'changed-client'}]){const a=await attempt(options);await assert.rejects(finish(a));}
  const browserBound=await attempt();await assert.rejects(finish({...browserBound,browser:'0'.repeat(64)}));
  const concurrent=await attempt();const before=exchangeCount;
  const results=await Promise.allSettled([finish(concurrent),finish(concurrent)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(exchangeCount,before+1);
  const result=results.find(r=>r.status==='fulfilled').value;
  const identity=await auth.identity({cookie:`itsm_session=${result.token}`});assert.equal(identity.id,employee);assert.deepEqual(identity.groups,[]);
  await assert.rejects(auth.identity({cookie:`itsm_session=${result.token}`,csrf:'wrong'},true));
  await auth.identity({cookie:`itsm_session=${result.token}`,csrf:result.csrfToken},true);
  await db.pool.query('UPDATE oidc_identity_links SET subject=$1 WHERE employee_id=$2',['replacement-subject',employee]);
  await assert.rejects(auth.identity({cookie:`itsm_session=${result.token}`}));
  await assert.rejects(finish(await attempt()),'unmapped subject cannot sign in');
  subject='replacement-subject';const fresh=await finish(await attempt());
  const unrelated=await sessionFor(control);
  await db.pool.query('UPDATE employees SET active=false WHERE id=$1',[employee]);
  await assert.rejects(auth.identity({cookie:`itsm_session=${fresh.token}`}));await assert.rejects(finish(await attempt()));
  await db.pool.query('UPDATE employees SET active=true WHERE id=$1',[employee]);
  await assert.rejects(auth.identity({cookie:`itsm_session=${fresh.token}`}));assert.equal((await auth.identity({cookie:`itsm_session=${unrelated.token}`})).id,control);
  const headers=new Map(),response={setHeader:(k,v)=>headers.set(k,v),redirect:(status,url)=>{assert.equal(status,303);headers.set('location',url);}};
  const callback=await attempt();await controller.callback({state:callback.state,code:callback.code},`__Secure-itsm_oidc=${callback.browser}`,response);
  assert.equal(headers.get('location'),'/');assert.equal(headers.get('Cache-Control'),'no-store');
  assert.ok(headers.get('Set-Cookie').some(v=>v.startsWith('itsm_session=')&&v.includes('HttpOnly; SameSite=Strict')&&v.endsWith('; Secure')));
  await controller.callback({state:callback.state,code:callback.code},`__Secure-itsm_oidc=${callback.browser}`,response);
  assert.equal(headers.get('location'),'/?login=failed');assert.ok(!JSON.stringify([...headers]).includes(callback.code));
  console.log('OIDC database/controller: PKCE start, expiry, client binding, browser binding, concurrent replay, active verified mapping, CSRF, remap/disable revocation and fixed redirects passed');
}finally{
  await db.pool.query('DELETE FROM oidc_login_attempts WHERE issuer=$1',[issuer]);
  await db.pool.query('DELETE FROM oidc_identity_links WHERE issuer=$1',[issuer]);
  await db.pool.query('DELETE FROM auth_sessions WHERE employee_id=ANY($1::text[])',[[employee,control]]);
  await db.pool.query('DELETE FROM operational_audits WHERE actor_id=ANY($1::text[])',[[employee,control]]);
  await db.pool.query('DELETE FROM employees WHERE id=ANY($1::text[])',[[employee,control]]);await db.pool.end();
}
