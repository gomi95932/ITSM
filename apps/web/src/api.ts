import type { SessionUser } from '@itsm/contracts';
export let currentUser: SessionUser | null = null;
export function setUser(user: SessionUser | null) { currentUser = user; }
export function devUser() { return sessionStorage.getItem('itsm-dev-user') ?? 'employee-1'; }
let development = false;
export function useDevelopment(value: boolean) { development = value; }
export class ApiError extends Error {
  constructor(public status: number,public code: string) { super(code); }
}
export async function api<T>(path: string,options: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`,{
    method:options.method ?? 'GET',credentials:'same-origin',headers:{
      ...(development ? { 'X-Dev-User':devUser() } : {}),
      ...(options.body !== undefined ? { 'Content-Type':'application/json' } : {}),
      ...(options.key ? { 'Idempotency-Key':options.key } : {}),
      ...(currentUser?.csrfToken ? { 'X-CSRF-Token':currentUser.csrfToken } : {}),
      ...(path === '/auth/dingtalk' ? { 'X-ITSM-Login':'1' } : {}),
    },body:options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status,data.code ?? 'REQUEST_FAILED');
  return data as T;
}
export const messages: Record<string,string> = {
  LOGIN_REQUIRED:'登录已失效，请重新进入应用。',EMPLOYEE_DISABLED:'账号已停用，请联系服务台。',CSRF_FAILED:'会话校验失败，请重新登录。',
  VERSION_CONFLICT:'工单已由其他人更新，已为你刷新，请确认后重试。',FORM_VERSION_CONFLICT:'服务表单已更新，请重新选择服务。',
  REQUEST_APPROVAL_POLICY_NOT_CONFIGURED:'该服务尚未开放审批，请联系服务台。',DRAFT_EXPIRED:'草稿已过期，请重新整理或直接填写表单。',
  ASR_UNAVAILABLE:'暂时无法转写，请继续使用文字填写。',INTAKE_RATE_LIMITED:'操作较频繁，请稍后再试。',
  EMPLOYEE_NOT_LINKED:'钉钉账号尚未关联公司员工，请联系管理员。',DINGTALK_NOT_CONFIGURED:'钉钉应用尚未配置，请联系管理员。',
};
export function errorText(error: unknown): string {
  return error instanceof ApiError ? messages[error.code] ?? `操作未完成（${error.status}），请检查后重试。` : '网络连接失败，请检查网络后重试。';
}
