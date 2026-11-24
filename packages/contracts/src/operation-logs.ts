export const OPERATION_LOG_MODULES={
  'service-structure':'服务组织与岗位任职',support:'支持组与成员',roles:'角色权限',routing:'派单配置',
  'automatic-dispatch':'主备自动派单','catalog-navigation':'目录展示分类',catalog:'服务发布',
  priority:'分级与时限',calendar:'工作日历',operations:'厂区与服务时限',tickets:'工单操作',
  authentication:'账号登录',directory:'人员同步',notifications:'消息通知',knowledge:'知识管理',attachments:'附件操作',system:'其他系统操作',
} as const;
export const OPERATION_LOG_RESULTS={APPLIED:'已生效',SUBMITTED:'已提交',REJECTED:'已拒绝',COMPLETED:'已完成',FAILED:'失败 / 隔离',RUNNING:'执行中'} as const;
export type OperationLogModule=keyof typeof OPERATION_LOG_MODULES;
export type OperationLogFilter={module?:string;object?:string;q?:string;actor?:string;result?:string;from?:string;to?:string;page?:number;size?:number};
export type OperationLogEntry={id:string;module:OperationLogModule;actorId:string|null;actorName:string|null;objectId:string;objectName:string;
  action:string;result:keyof typeof OPERATION_LOG_RESULTS;reason:string|null;createdAt:string};
export type OperationLogDetail=OperationLogEntry & {sourceTable:string;sourceId:string;requestId:string|null;executionPrincipal:string|null;
  beforeValue:unknown;afterValue:unknown;valueMeaning:'PROPOSED'|'RECORDED';
  changes:{field:string;before:unknown;after:unknown}[];changesTruncated:boolean};
export type OperationLogList={items:OperationLogEntry[];total:number;page:number;size:number};
