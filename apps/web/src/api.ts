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
  INVALID_GROUP_CHANGE:'请核对支持组、人员、变更类型、版本和处理依据。',GROUP_EXISTS:'该支持组编码已存在，请刷新核对。',
  GROUP_PEOPLE_SEARCH_REQUIRED:'请输入至少 2 个字符查找工程师。',GROUP_SELF_CHANGE_DENIED:'不能提交自己的成员变更，请由其他管理人员发起。',
  GROUP_INDEPENDENT_REVIEW_REQUIRED:'须由另一名平台管理员复核，复核人不能是提案人或变更对象。',
  GROUP_VERSION_CONFLICT:'支持组已更新，请拒绝过期提案，刷新后按当前版本重新发起。',
  GROUP_SUBJECT_UNAVAILABLE:'新增成员须为在职员工。',GROUP_MEMBERSHIP_CONFLICT:'成员关系已经变化，请刷新后核对。',
  GROUP_CHANGE_ID_CONFLICT:'此变更编号已有不同内容，请重新发起。',GROUP_CHANGE_PENDING:'该员工已有待复核的成员变更。',
  GROUP_CHANGE_VERSION_CONFLICT:'变更已经处理或版本变化，请刷新后核对。',
  GROUP_RESPONSIBILITY_TRANSFER_REQUIRED:'该成员仍有在办工单、待接收交接、未结交付或知识草稿，请先完成责任移交及收尾。',
  GROUP_STALE_ROLE_REVIEW_REQUIRED:'该员工仍有未撤销的旧组角色，请先在角色授权中复核并撤销，再重新入组。',
  GROUP_LAST_MEMBER_REQUIRED:'不能移除最后一名在职成员，请先完成接替人员入组。',GROUP_LAST_LEAD_REQUIRED:'不能移除最后一名有效组长，请先完成接替组长授权。',
  GROUP_SPECIALIST_CONTINUITY_REQUIRED:'请先为该组的 P1 确认、知识复核或知识编辑配置接替人员。',
  DISPATCH_ROLE_REQUIRED:'未接单工单的派人和分类须由本组有效调度员或组长操作；工程师可先领取再处理。',
  INVALID_ROLE_BINDING:'请核对角色、人员、支持组、有效期和处理依据。',ROLE_SELF_GRANT_DENIED:'不能给自己提交角色授权。',
  ROLE_INDEPENDENT_REVIEW_REQUIRED:'复核人须是其他平台管理员，且不能是申请人或被授权人。',
  ROLE_SUBJECT_UNAVAILABLE:'被授权人须在职；组角色还须是对应支持组成员。',ROLE_VALIDITY_INVALID:'有效期无效或已经到期，最长支持 366 天。',
  ROLE_BINDING_EXISTS:'已有待复核或未撤销的同范围授权，请先核对并撤销旧授权。',ROLE_BINDING_ID_CONFLICT:'此提案编号已有其他内容，请重新发起。',
  ROLE_VERSION_CONFLICT:'授权已被其他人更新，列表已刷新，请重新核对。',ROLE_STATE_CONFLICT:'授权状态已变化，列表已刷新，请重新核对。',
  ROLE_ADMIN_CONTINUITY_REQUIRED:'至少保留两名有效平台管理员；请先完成接替授权。紧急人员停用仍走现有受控停用渠道。',
  INVALID_FEEDBACK:'请选择 1 至 5 分，意见最多 1000 字。',FEEDBACK_NOT_AVAILABLE:'工单尚未关闭或不属于故障报障，暂不能评价。',
  FEEDBACK_ALREADY_SUBMITTED:'此工单已评价，请刷新查看。',FEEDBACK_REQUESTER_REQUIRED:'仅报障本人可评价服务。',
  PRIORITY_REVIEWER_REQUIRED:'仅当前责任组的授权主管可确认，且不能确认本人提交的工单。',
  DELEGATION_REQUIRED:'代报授权已撤销、到期或人员不可用，请由本人重新提交。',
  TICKET_ACTION_NOT_AUTHORIZED:'当前身份无权执行此操作；代报授权不包含审批、确认交付、撤销或重开。',
  INVALID_DELEGATION:'请核对受托人、有效期并确认授权范围。',DELEGATE_UNAVAILABLE:'受托人当前不可用，请选择在职支持人员。',
  DELEGATION_CONFLICT_OR_EXPIRY:'授权信息冲突或有效期不正确，请刷新后重试（最长 7 天）。',
  CLASSIFICATION_OWNER_REQUIRED:'仅当前处理人或未接单队列的责任组可纠偏。',
  CLASSIFICATION_NOT_ALLOWED:'当前状态或待交接期间不能更改分类。',CLASSIFICATION_UNCHANGED:'请选择不同的服务分类。',
  CLASSIFICATION_HANDOVER_REQUIRED:'新分类属于其他支持组，请先完成双向交接，再由接收人纠偏。',
  INVALID_CLASSIFICATION:'请核对分类、必填字段和纠偏原因。',
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
  INVALID_KNOWLEDGE_DRAFT:'请检查标题、正文、责任组和复核日期（须在未来 1 至 366 天内）。',
  INVALID_KNOWLEDGE_ACTION:'操作参数无效，请刷新后重试。',KNOWLEDGE_ROLE_REQUIRED:'当前账号尚未被任命为该组知识编辑或审校人。',
  KNOWLEDGE_AUTHOR_REQUIRED:'只有原作者可修订此草稿。',KNOWLEDGE_VERSION_OR_STATE_CONFLICT:'知识状态或版本已变化，请刷新后重试。',
  KNOWLEDGE_SOURCE_UNAVAILABLE:'关联故障工单不可用。',INVALID_KNOWLEDGE_SEARCH:'搜索内容无效。',
};
export function errorText(error: unknown): string {
  return error instanceof ApiError ? messages[error.code] ?? `操作未完成（${error.status}），请检查后重试。` : '网络连接失败，请检查网络后重试。';
}
