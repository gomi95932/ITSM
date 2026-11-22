export type DingtalkWebSettings = { corpId: string; clientId: string; clientSecret: string; redirectUri: string };
export function dingtalkWebSettings(env: NodeJS.ProcessEnv = process.env): DingtalkWebSettings | undefined {
  if (env.ENABLE_DINGTALK_WEB_LOGIN !== 'true' || env.COOKIE_SECURE !== 'true') return;
  try {
    const app = new URL(env.ITSM_PUBLIC_URL ?? '');
    if (app.protocol !== 'https:' || app.username || app.password || app.search || app.hash || app.pathname !== '/') return;
    if (![env.DINGTALK_CORP_ID,env.DINGTALK_APP_KEY,env.DINGTALK_APP_SECRET].every(v=>v && v===v.trim())) return;
    return { corpId:env.DINGTALK_CORP_ID!,clientId:env.DINGTALK_APP_KEY!,clientSecret:env.DINGTALK_APP_SECRET!,
      redirectUri:`${app.origin}/api/v1/auth/dingtalk-web/callback` };
  } catch { return; }
}
