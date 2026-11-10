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
  PRIORITY_REVIEWER_REQUIRED:'仅当前责任组的授权主管可确认，且不能确认本人提交的工单。',
  PRIORITY_REVIEW_NOT_PENDING:'当前工单不再等待优先级确认，请刷新。',INVALID_PRIORITY_REVIEW:'请选择优先级并填写确认依据。',
  OWNER_GROUP_REQUIRED:'仅当前责任组可执行此操作。',PERSONAL_OWNER_REQUIRED:'仅当前处理人可执行此操作，请先完成交接。',
  TICKET_ALREADY_ASSIGNED:'工单已有处理人，请刷新工单。',HANDOVER_PENDING:'工单正在交接，请先处理现有交接。',
  HANDOVER_TARGET_REQUIRED:'仅指定接收人可确认或退回交接。',HANDOVER_NOT_PENDING:'当前没有待处理的交接。',
  INVALID_HANDOVER_TARGET:'接收人须为目标支持组内的有效成员，且不能是当前操作人。',
  REASSIGN_DETAILS_REQUIRED:'请选择目标支持组、接收人并填写交接原因。',HANDOVER_REASON_REQUIRED:'请填写退回或撤回交接的原因。',
  CONTENT_DECLARATION_REQUIRED:'请确认本次内容不含密码、密钥及安全事件证据。',
  SECURITY_CHANNEL_REQUIRED:'此内容不能提交到普通工单或语音草稿，请使用安全事件联络渠道；请勿粘贴密码、密钥或证据。',
  LOGIN_REQUIRED:'登录已失效，请重新进入应用。',EMPLOYEE_DISABLED:'账号已停用，请联系服务台。',CSRF_FAILED:'会话校验失败，请重新登录。',
  VERSION_CONFLICT:'工单已由其他人更新，已为你刷新，请确认后重试。',FORM_VERSION_CONFLICT:'服务表单已更新，请重新选择服务。',
  REQUEST_APPROVAL_POLICY_NOT_CONFIGURED:'该服务尚未开放审批，请联系服务台。',DRAFT_EXPIRED:'草稿已过期，请重新整理或直接填写表单。',
  ASR_UNAVAILABLE:'暂时无法转写，请继续使用文字填写。',INTAKE_RATE_LIMITED:'操作较频繁，请稍后再试。',
  EMPLOYEE_NOT_LINKED:'钉钉账号尚未关联公司员工，请联系管理员。',DINGTALK_NOT_CONFIGURED:'钉钉应用尚未配置，请联系管理员。',
};
export function errorText(error: unknown): string {
  return error instanceof ApiError ? messages[error.code] ?? `操作未完成（${error.status}），请检查后重试。` : '网络连接失败，请检查网络后重试。';
}
