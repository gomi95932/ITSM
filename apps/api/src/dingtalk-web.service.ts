import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { dingtalkWebSettings } from './dingtalk-web-config.js';

const digest = (value:string)=>createHash('sha256').update(value).digest('hex');
const validId = (value:unknown):value is string=>typeof value==='string' && value.length>0 && value.length<=512;
@Injectable()
export class DingtalkWebService {
  constructor(private readonly db:Database,private readonly auth:AuthService) {}
  private settings() {
    const settings=dingtalkWebSettings();
    if(!settings)throw new ServiceUnavailableException({code:'DINGTALK_WEB_NOT_CONFIGURED'});
    return settings;
  }
  async start() {
    const settings=this.settings(),state=randomBytes(32).toString('hex'),browser=randomBytes(32).toString('hex');
    const url=new URL('https://login.dingtalk.com/oauth2/auth');
    for(const [key,value] of Object.entries({client_id:settings.clientId,redirect_uri:settings.redirectUri,
      response_type:'code',scope:'openid corpid',prompt:'consent',state}))url.searchParams.set(key,value);
    await this.db.transaction(async client=>{
      await client.query('DELETE FROM dingtalk_web_login_attempts WHERE expires_at<=now()');
      await client.query(`INSERT INTO dingtalk_web_login_attempts(state_hash,browser_hash,configuration_hash)
        VALUES($1,$2,$3)`,[digest(state),digest(browser),digest(JSON.stringify(settings))]);
    });
    return {url:url.href,browser};
  }
  private async json(url:string,init:RequestInit={}) {
    const response=await fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('PROVIDER_FAILED');
    return await response.json();
  }
  async finish(query:Record<string,unknown>,browser?:string) {
    const settings=this.settings();
    if(typeof query.state!=='string'||!/^[a-f0-9]{64}$/.test(query.state)||!browser||!/^[a-f0-9]{64}$/.test(browser)
      ||Object.values(query).some(v=>typeof v!=='string'||v.length>4096))
      throw new UnauthorizedException({code:'DINGTALK_WEB_LOGIN_FAILED'});
    // Consume the browser-bound attempt before exchanging a code, including failed or cancelled callbacks.
    const attempt=await this.db.pool.query(`DELETE FROM dingtalk_web_login_attempts WHERE state_hash=$1 AND browser_hash=$2
      AND configuration_hash=$3 AND expires_at>now() RETURNING state_hash`,[digest(query.state),digest(browser),digest(JSON.stringify(settings))]);
    if(!attempt.rowCount)throw new UnauthorizedException({code:'DINGTALK_WEB_LOGIN_FAILED'});
    try {
      if(query.error||typeof query.authCode!=='string'||!/^[a-zA-Z0-9_-]{6,512}$/.test(query.authCode))throw new Error('CODE_REQUIRED');
      const claimed=await this.db.pool.query(`INSERT INTO auth_code_uses(code_hash) VALUES($1)
        ON CONFLICT DO NOTHING RETURNING code_hash`,[digest(`dingtalk-web:${settings.clientId}:${query.authCode}`)]);
      if(!claimed.rowCount)throw new Error('CODE_REPLAYED');
      const tokens=await this.json('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:settings.clientId,
          clientSecret:settings.clientSecret,code:query.authCode,grantType:'authorization_code'})});
      if(!validId(tokens.accessToken)||tokens.corpId!==settings.corpId)throw new Error('ENTERPRISE_MISMATCH');
      const profile=await this.json('https://api.dingtalk.com/v1.0/contact/users/me',{
        headers:{'x-acs-dingtalk-access-token':tokens.accessToken}});
      if(!validId(profile.unionId))throw new Error('IDENTITY_REQUIRED');
      const tokenUrl=new URL('https://oapi.dingtalk.com/gettoken');
      tokenUrl.searchParams.set('appkey',settings.clientId);tokenUrl.searchParams.set('appsecret',settings.clientSecret);
      const appToken=await this.json(tokenUrl.href);
      if(appToken.errcode!==0||!validId(appToken.access_token))throw new Error('APP_TOKEN_FAILED');
      const mapping=await this.json(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(appToken.access_token)}`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unionid:profile.unionId})});
      if(mapping.errcode!==0||!validId(mapping.result?.userid))throw new Error('ENTERPRISE_MEMBER_REQUIRED');
      return await this.db.transaction(async client=>{
        const employee=await client.query(`SELECT e.id FROM employees e JOIN identity_links l ON l.employee_id=e.id
          WHERE l.corp_id=$1 AND l.ding_user_id=$2 AND e.active=true FOR SHARE OF e,l`,[settings.corpId,mapping.result.userid]);
        if(!employee.rowCount)throw new Error('EMPLOYEE_NOT_LINKED');
        const session=await this.auth.issueSession(client,employee.rows[0].id);
        await client.query("INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,'DINGTALK_WEB_LOGIN',$1)",[employee.rows[0].id]);
        return session;
      });
    } catch { throw new UnauthorizedException({code:'DINGTALK_WEB_LOGIN_FAILED'}); }
  }
}
