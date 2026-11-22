import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { oidcSettings, type OidcSettings } from './oidc-config.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type LoginAttempt = { verifier: string; nonce: string; issuer: string; client_id: string; redirect_uri: string };
export async function oidcClaims(config: oidc.Configuration, url: URL, state: string, attempt: LoginAttempt) {
  const tokens = await oidc.authorizationCodeGrant(config, url, {
    pkceCodeVerifier: attempt.verifier, expectedState: state, expectedNonce: attempt.nonce, idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims || claims.iss !== attempt.issuer || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512)
    throw new UnauthorizedException({ code: 'OIDC_LOGIN_FAILED' });
  return { issuer: claims.iss, subject: claims.sub };
}
@Injectable()
export class OidcService {
  private cached?: { key: string; expires: number; promise: Promise<oidc.Configuration> };
  constructor(private readonly db: Database, private readonly auth: AuthService) {}
  private settings() {
    const settings = oidcSettings();
    if (!settings) throw new ServiceUnavailableException({ code: 'OIDC_NOT_CONFIGURED' });
    return settings;
  }
  private async configuration(settings: OidcSettings) {
    const key = digest(JSON.stringify(settings));
    if (!this.cached || this.cached.key !== key || this.cached.expires < Date.now()) {
      const promise = oidc.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret, undefined,
        { timeout: 10, execute: [oidc.enableNonRepudiationChecks] });
      this.cached = { key, expires: Date.now() + 300000, promise };
    }
    try { return await this.cached.promise; }
    catch { this.cached = undefined; throw new ServiceUnavailableException({ code: 'OIDC_UNAVAILABLE' }); }
  }
  async start() {
    const settings = this.settings(), config = await this.configuration(settings);
    const state = oidc.randomState(), browser = randomBytes(32).toString('hex');
    const verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, { scope: 'openid', response_mode: 'query',
      redirect_uri: settings.redirectUri, state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
    await this.db.transaction(async client => {
      await client.query('DELETE FROM oidc_login_attempts WHERE expires_at<=now()');
      await client.query(`INSERT INTO oidc_login_attempts(state_hash,browser_hash,issuer,client_id,redirect_uri,verifier,nonce)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [digest(state),digest(browser),settings.issuer,settings.clientId,settings.redirectUri,verifier,nonce]);
    });
    return { url: url.href, browser };
  }
  async finish(query: Record<string, unknown>, browser?: string) {
    const settings = this.settings();
    if (typeof query.state !== 'string' || !/^[a-zA-Z0-9_-]{20,128}$/.test(query.state)
      || !browser || !/^[a-f0-9]{64}$/.test(browser)
      || Object.values(query).some(v => typeof v !== 'string' || v.length > 4096))
      throw new UnauthorizedException({ code: 'OIDC_LOGIN_FAILED' });
    // Atomic consumption fences concurrent callbacks before any code exchange.
    const claimed = await this.db.pool.query(`DELETE FROM oidc_login_attempts WHERE state_hash=$1 AND browser_hash=$2
      AND expires_at>now() AND issuer=$3 AND client_id=$4 AND redirect_uri=$5 RETURNING *`,
    [digest(query.state),digest(browser),settings.issuer,settings.clientId,settings.redirectUri]);
    if (!claimed.rowCount) throw new UnauthorizedException({ code: 'OIDC_LOGIN_FAILED' });
    const url = new URL(settings.redirectUri);
    for (const [key,value] of Object.entries(query)) url.searchParams.set(key, value as string);
    try {
      const identity = await oidcClaims(await this.configuration(settings), url, query.state, claimed.rows[0]);
      return await this.db.transaction(async client => {
        const link = await client.query(`SELECT e.id FROM employees e JOIN oidc_identity_links l ON l.employee_id=e.id
          WHERE l.issuer=$1 AND l.subject=$2 AND e.active=true FOR SHARE OF e,l`, [identity.issuer,identity.subject]);
        if (!link.rowCount) throw new UnauthorizedException({ code: 'OIDC_LOGIN_FAILED' });
        const session = await this.auth.issueSession(client, link.rows[0].id);
        await client.query("INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,'OIDC_LOGIN',$1)", [link.rows[0].id]);
        return session;
      });
    } catch { throw new UnauthorizedException({ code: 'OIDC_LOGIN_FAILED' }); }
  }
}
