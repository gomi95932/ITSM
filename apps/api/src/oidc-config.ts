export type OidcSettings = { issuer: string; clientId: string; clientSecret: string; redirectUri: string };
export function oidcSettings(env: NodeJS.ProcessEnv = process.env): OidcSettings | undefined {
  if (env.ENABLE_OIDC_LOGIN !== 'true' || env.COOKIE_SECURE !== 'true') return;
  try {
    const issuer = new URL(env.OIDC_ISSUER ?? ''), app = new URL(env.ITSM_PUBLIC_URL ?? '');
    if ([issuer,app].some(u => u.protocol !== 'https:' || !!u.username || !!u.password || !!u.search || !!u.hash)
      || app.pathname !== '/' || !env.OIDC_CLIENT_ID?.trim() || !env.OIDC_CLIENT_SECRET?.trim()) return;
    if (env.OIDC_ISSUER !== env.OIDC_ISSUER?.trim()) return;
    return { issuer: env.OIDC_ISSUER!, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: `${app.origin}/api/v1/auth/oidc/callback` };
  } catch { return; }
}
