import type {InjectionKey} from 'vue';
import type {OperationLogFilter} from '@itsm/contracts';
export const operationLogNavigation:InjectionKey<(filter:OperationLogFilter)=>void>=Symbol('operation-log-navigation');
export const canReadOperationLogs:InjectionKey<()=>boolean>=Symbol('can-read-operation-logs');
const actions:Record<string,string>={APPLIED:'保存并生效',PROPOSED:'提交配置',APPROVED:'批准生效',REJECTED:'拒绝',REVOKED:'撤销',BOOTSTRAPPED:'受控初始化',INITIALIZED:'初始化',HANDED_OFF:'管理员交接',HANDOFF_REVOKED:'撤销交接权限',PUBLISH:'发布',UNPUBLISH:'取消发布',CREATE:'新增',REVISE:'修订',SUBMIT:'提交',APPROVE:'批准',REJECT:'拒绝',ARCHIVE:'归档',DINGTALK_WEB_LOGIN:'钉钉扫码登录',OIDC_LOGIN:'企业账号登录',SUCCEEDED:'同步完成',FAILED:'执行失败',RUNNING:'执行中',AUTOMATIC_DISPATCH_CONFIGURED:'配置主备派单'};
const kinds:Record<string,string>={GROUP_CREATE:'新增支持组',GROUP_UPDATE:'修改支持组',GROUP_DISABLE:'停用支持组',GROUP_RESTORE:'恢复支持组',MEMBER_ADD:'增加成员',MEMBER_REMOVE:'移除成员'};
export function operationAction(action:string){
  if(action==='MEMBER_PRIVILEGES_APPLIED')return '成员权限 · 保存并生效';
  if(action==='QUEUED')return '提交人员同步';
  if(actions[action])return actions[action];
  for(const [key,label] of Object.entries(kinds))if(action.startsWith(`${key}_`))return `${label} · ${actions[action.slice(key.length+1)]??action.slice(key.length+1)}`;
  for(const prefix of ['PRIORITY_POLICY_','SLA_CALENDAR_','OPERATIONS_'])if(action.startsWith(prefix))return actions[action.slice(prefix.length)]??action;
  return action;
}
