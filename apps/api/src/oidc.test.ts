import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as oidc from 'openid-client';
import { oidcSettings } from './oidc-config.js';
import { oidcClaims, OidcService, type LoginAttempt } from './oidc.service.js';
import { AuthService } from './auth.service.js';
import type { Database } from './database.service.js';
const issuer = 'https://identity.example.test';
const env = { ENABLE_OIDC_LOGIN:'true',COOKIE_SECURE:'true',OIDC_ISSUER:issuer,OIDC_CLIENT_ID:'itsm',
  OIDC_CLIENT_SECRET:'fixture-only-client-value',ITSM_PUBLIC_URL:'https://help.example.test' };
const state = 'a'.repeat(43), nonce = 'fixture-nonce', verifier = 'v'.repeat(43);
const attempt: LoginAttempt = { issuer,client_id:'itsm',redirect_uri:'https://help.example.test/api/v1/auth/oidc/callback',verifier,nonce };
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const keys = generateKeyPairSync('rsa',{modulusLength:2048});
const wrongKeys = generateKeyPairSync('rsa',{modulusLength:2048});
const jwk = { ...keys.publicKey.export({format:'jwk'}),kid:'fixture',use:'sig',alg:'RS256' };
function fixture(overrides: Record<string,unknown> = {}, badSignature = false) {
  const config = new oidc.Configuration({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`},'itsm',env.OIDC_CLIENT_SECRET);
  oidc.enableNonRepudiationChecks(config); config.timeout = 2;
  let exchanges = 0;
  config[oidc.customFetch] = async (input,init) => {
    const url = String(input);
    if(url === `${issuer}/jwks`)return Response.json({keys:[jwk]});
    assert.equal(url,`${issuer}/token`); exchanges++;
    const params = new URLSearchParams(String(init?.body));
    assert.equal(params.get('code_verifier'),verifier);assert.equal(params.get('redirect_uri'),attempt.redirect_uri);
    const header = Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url');
    const payload = Buffer.from(JSON.stringify({iss:issuer,sub:'verified-subject',aud:'itsm',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,nonce,...overrides})).toString('base64url');
    const value = `${header}.${payload}`;
    const signature = sign('RSA-SHA256',Buffer.from(value),badSignature?wrongKeys.privateKey:keys.privateKey).toString('base64url');
    return Response.json({access_token:'fixture-only-access',token_type:'Bearer',expires_in:300,id_token:`${value}.${signature}`});
  };
  return {config,exchanges:()=>exchanges};
}
function callback(value = state) {const url = new URL(attempt.redirect_uri);url.searchParams.set('code','fixture-code');url.searchParams.set('state',value);return url;}
test('OIDC requires explicit HTTPS configuration and retains the exact issuer identifier',()=>{
  assert.equal(oidcSettings(env)?.issuer,issuer);
  assert.equal(oidcSettings(env)?.redirectUri,attempt.redirect_uri);
  for(const changed of [{ENABLE_OIDC_LOGIN:'false'},{COOKIE_SECURE:'false'},{OIDC_CLIENT_SECRET:''},
    {OIDC_ISSUER:'http://identity.example.test'},{ITSM_PUBLIC_URL:'http://help.example.test'},
    {ITSM_PUBLIC_URL:'https://help.example.test/path'},{OIDC_ISSUER:'https://identity.example.test?x=1'},
    {OIDC_ISSUER:'https://user:pass@identity.example.test'},{OIDC_ISSUER:` ${issuer}`}])
    assert.equal(oidcSettings({...env,...changed}),undefined);
});
test('OIDC protocol validates state, PKCE, nonce, issuer, audience, expiry and cryptographic signature',async()=>{
  const good = fixture();assert.deepEqual(await oidcClaims(good.config,callback(),state,attempt),{issuer,subject:'verified-subject'});
  const badState = fixture();await assert.rejects(oidcClaims(badState.config,callback('other'),state,attempt));assert.equal(badState.exchanges(),0);
  for(const claims of [{nonce:'other'},{iss:'https://other.example.test'},{aud:'other-client'},{exp:1},{sub:''}]){
    const invalid = fixture(claims);await assert.rejects(oidcClaims(invalid.config,callback(),state,attempt));
  }
  const forged = fixture({},true);await assert.rejects(oidcClaims(forged.config,callback(),state,attempt));
});
test('OIDC callback is browser-bound, single-use and cannot create or activate an employee',async()=>{
  const original = {...process.env};Object.assign(process.env,env);
  try {
    const browser = 'b'.repeat(64);let consumed = false, linked = true, sessions = 0;
    const queries: string[] = [];
    const client = {query:async(sql:string,values:unknown[])=>{
      queries.push(sql);
      if(sql.includes('JOIN oidc_identity_links')){assert.ok(sql.includes('e.active=true'));return {rowCount:linked?1:0,rows:linked?[{id:'fixture-employee'}]:[]};}
      if(sql.includes('INSERT INTO auth_sessions')){sessions++;assert.equal(values[2],'fixture-employee');assert.notEqual(values[0],browser);}
      return {rowCount:1,rows:[]};
    }};
    const db = {pool:{query:async(sql:string,values:unknown[])=>{
      assert.ok(sql.includes('expires_at>now()'));assert.ok(sql.includes('issuer=$3 AND client_id=$4 AND redirect_uri=$5'));
      if(consumed||values[0]!==digest(state)||values[1]!==digest(browser))return {rowCount:0,rows:[]};
      consumed = true;return {rowCount:1,rows:[attempt]};
    }},transaction:async(fn:(c:unknown)=>Promise<unknown>)=>fn(client)} as unknown as Database;
    const service = new OidcService(db,new AuthService(db));
    (service as unknown as {configuration:()=>Promise<oidc.Configuration>}).configuration=async()=>fixture().config;
    await assert.rejects(service.finish({state,code:'fixture-code'},'c'.repeat(64)));assert.equal(consumed,false);
    await assert.rejects(service.finish({state:[state],code:'fixture-code'},browser));assert.equal(consumed,false);
    const result = await service.finish({state,code:'fixture-code'},browser);assert.equal(result.token.length,64);assert.equal(sessions,1);
    await assert.rejects(service.finish({state,code:'fixture-code'},browser));assert.equal(sessions,1);
    consumed=false;linked=false;await assert.rejects(service.finish({state,code:'fixture-code'},browser));assert.equal(sessions,1);
    assert.ok(!queries.some(sql=>/INSERT INTO employees|UPDATE employees/.test(sql)));
  } finally {
    for(const key of Object.keys(env)){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  }
});
