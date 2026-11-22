import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Database } from './database.service.js';
import { ROLE_EFFECTIVE_SQL } from './role-policy.js';
import type { PoolClient } from 'pg';
import { oidcSettings } from './oidc-config.js';

export type Identity = { id: string; name: string; groups: string[]; priorityReviewGroups?: string[]; csrfToken?: string; canManageRoles?:boolean; canManageRouting?:boolean };
export type AuthHeaders = { devUser?: string; cookie?: string; csrf?: string };
export const devEnabled = () => process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEV_AUTH === 'true';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function sessionToken(cookie?: string): string | undefined {
  return cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('itsm_session='))?.slice(13);
}

@Injectable()
export class AuthService {
  private token?: { value: string; expires: number };
  constructor(private readonly db: Database) {}

  async identity(headers: AuthHeaders, write = false): Promise<Identity> {
    const token = sessionToken(headers.cookie);
    let id: string | undefined;
    let csrf: string | undefined;
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const session = await this.db.pool.query('SELECT employee_id,csrf_token FROM auth_sessions WHERE token_hash=$1 AND expires_at>now()', [digest(token)]);
      id = session.rows[0]?.employee_id; csrf = session.rows[0]?.csrf_token;
      if (!id) throw new UnauthorizedException({ code: 'LOGIN_REQUIRED' });
      if (write && (!csrf || csrf !== headers.csrf)) throw new ForbiddenException({ code: 'CSRF_FAILED' });
    } else if (devEnabled()) { id = headers.devUser; }
    if (!id) throw new UnauthorizedException({ code: 'LOGIN_REQUIRED' });
    const employee = await this.db.pool.query('SELECT id,display_name FROM employees WHERE id=$1 AND active=true', [id]);
    if (!employee.rowCount) throw new UnauthorizedException({ code: 'EMPLOYEE_DISABLED' });
    const groups = await this.db.pool.query('SELECT group_id FROM group_memberships WHERE employee_id=$1', [id]);
    const reviews = await this.db.pool.query('SELECT group_id FROM priority_reviewers WHERE employee_id=$1', [id]);
    const roles=await this.db.pool.query(`SELECT DISTINCT r.role_code FROM role_bindings r WHERE r.employee_id=$1
      AND r.role_code IN ('PLATFORM_ADMIN','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}`,[id]);
    return { id, name: employee.rows[0].display_name, groups: groups.rows.map(r => r.group_id), priorityReviewGroups: reviews.rows.map(r => r.group_id), csrfToken: csrf,
      canManageRoles:!!roles.rowCount,canManageRouting:roles.rows.some(r=>r.role_code==='PLATFORM_ADMIN') };
  }

  config() {
    return { mode: devEnabled() ? 'development' : 'dingtalk', corpId: process.env.DINGTALK_CORP_ID ?? '',
      configured: !!(process.env.DINGTALK_APP_KEY && process.env.DINGTALK_APP_SECRET && process.env.DINGTALK_CORP_ID),
      oidcConfigured: !!oidcSettings() };
  }

  async issueSession(client: PoolClient, employeeId: string) {
    const token = randomBytes(32).toString('hex'), csrfToken = randomBytes(24).toString('hex');
    await client.query("INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at) VALUES ($1,$2,$3,now()+interval '8 hours')", [digest(token),csrfToken,employeeId]);
    return { token,csrfToken };
  }

  async login(code: unknown) {
    if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{6,512}$/.test(code)) throw new UnauthorizedException({ code: 'INVALID_AUTH_CODE' });
    const { configured } = this.config();
    if (!configured) throw new ServiceUnavailableException({ code: 'DINGTALK_NOT_CONFIGURED' });
    if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'true')
      throw new ServiceUnavailableException({ code: 'HTTPS_REQUIRED' });
    const claimed = await this.db.pool.query('INSERT INTO auth_code_uses(code_hash) VALUES ($1) ON CONFLICT DO NOTHING RETURNING code_hash', [digest(code)]);
    if (!claimed.rowCount) throw new UnauthorizedException({ code: 'AUTH_CODE_REPLAYED' });
    try {
      if (!this.token || this.token.expires < Date.now()) {
        const url = new URL('https://oapi.dingtalk.com/gettoken');
        url.searchParams.set('appkey', process.env.DINGTALK_APP_KEY!); url.searchParams.set('appsecret', process.env.DINGTALK_APP_SECRET!);
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const data = await response.json() as { errcode: number; access_token?: string; expires_in?: number };
        if (!response.ok || data.errcode !== 0 || !data.access_token) throw new Error('TOKEN_FAILED');
        this.token = { value: data.access_token, expires: Date.now() + Math.min(data.expires_in ?? 7200, 7200) * 1000 - 60000 };
      }
      const response = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(this.token.value)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(10000),
      });
      const data = await response.json() as { errcode: number; result?: { userid?: string } };
      if (!response.ok || data.errcode !== 0 || !data.result?.userid) throw new Error('CODE_EXCHANGE_FAILED');
      return await this.db.transaction(async client => {
        const employee = await client.query(`SELECT e.id FROM employees e JOIN identity_links l ON l.employee_id=e.id
          WHERE l.corp_id=$1 AND l.ding_user_id=$2 AND e.active=true FOR SHARE OF e,l`, [process.env.DINGTALK_CORP_ID, data.result!.userid]);
        if (!employee.rowCount) throw new ForbiddenException({ code: 'EMPLOYEE_NOT_LINKED' });
        return this.issueSession(client, employee.rows[0].id);
      });
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      this.token = undefined;
      throw new UnauthorizedException({ code: 'DINGTALK_LOGIN_FAILED' });
    }
  }

  async logout(cookie?: string) {
    const token = sessionToken(cookie);
    if (token) await this.db.pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [digest(token)]);
  }
}
