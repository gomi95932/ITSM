import {BadRequestException} from '@nestjs/common';
import {OPERATION_LOG_MODULES,OPERATION_LOG_RESULTS} from '@itsm/contracts';

export function operationLogFilters(input:Record<string,unknown>){
  const invalid=()=>new BadRequestException({code:'INVALID_OPERATION_LOG_FILTER'});
  if(Object.keys(input).some(k=>!['module','object','q','actor','result','from','to','page','size'].includes(k)))throw invalid();
  const text=(key:string,max=200)=>{const value=input[key];if(value===undefined||value==='')return '';
    if(typeof value!=='string'||value.length>max)throw invalid();return value.trim();};
  const module=text('module'),result=text('result');
  if(module&&!Object.hasOwn(OPERATION_LOG_MODULES,module)||result&&!Object.hasOwn(OPERATION_LOG_RESULTS,result))throw invalid();
  const integer=(key:string,fallback:number,max:number)=>{const raw=input[key];if(raw===undefined)return fallback;
    if(typeof raw!=='string'||!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>max)throw invalid();return Number(raw);};
  const date=(key:string)=>{const value=text(key,40);if(!value)return '';
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw invalid();
    const [year,month,day]=value.slice(0,10).split('-').map(Number);
    if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())throw invalid();
    return new Date(value).toISOString();};
  const from=date('from'),to=date('to');if(from&&to&&from>to)throw invalid();
  return {module,result,object:text('object'),q:text('q'),actor:text('actor'),from,to,page:integer('page',1,10000),size:integer('size',20,100)};
}

const ticketFields=new Set(['status','priority','initialPriority','ownerGroupId','assigneeId','pendingGroupId','pendingAssigneeId','version','serviceCode','requesterId','resolvedAt','closedAt']);
const memberPrivilegeFields=new Set(['id','groupId','employeeId','version','privileges','catalogServiceCodes']);
const directoryFields=new Set(['state','triggerSource','peopleCount','createdCount','updatedCount','disabledCount','missingCount','errorDetails','stage','vendorCode','vendorSubcode']);
const safeFields=new Set(`id code name title enabled active status state version kind groupId group_id employeeId employee_id roleCode role_code validFrom validTo valid_from valid_to duty domainId systemId positionId primaryPositionId collaboratingPositionIds serviceCode service_code domains systems positions appointments mappings catalog catalogChange published sortOrder path items config policy policyId fallbackGroupId receiveMinutes calendar timeZone startHour endHour days holidays workdays approved matrix targets response resolution criticalServices reviewMinutes COMPANY DEPARTMENT INDIVIDUAL HIGH MEDIUM LOW P1 P2 P3 P4 primary_minutes backup_minutes backup_position_ids backup_employee_ids primaryMinutes backupMinutes backupMinutes backupPositionIds backupEmployeeIds groupName employeeName members roles privileges description reason reviewReason administration_version fallback_group_id routing_version expectedGroupVersion expectedVersion siteEnforced sites employeeSites groupSites positionSites serviceSites siteRoutes slaTemplates serviceSlas siteIds siteId templateId priority peopleCount createdCount updatedCount disabledCount missingCount ownerGroupId assigneeId pendingGroupId pendingAssigneeId requesterId initialPriority resolvedAt closedAt category subcategory fields field type required options value label summary articleId publishedVersion currentVersion visibility`.split(/\s+/));
for(const key of ['key','homeSiteId','visibleGroups','formVersion','required_fields','visible_groups','sort_order','form_version','maxValidityDays','max_validity_days','approval','steps','approverId','initialPublisherId','receive_minutes','member_ids','employee_ids','group','member','reviewed_by','requested_by','management_mode','source','created_at','reviewed_at','reason','review_reason','activeMembers','dispatchers','maxOpenTickets'])safeFields.add(key);
export function redactLogText(value:string):string{return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]+|Bearer\s+[^\s,;]+)/gi,'[已隐藏凭据]')
  .replace(/((?:password|passwd|token|secret|cookie|api[_-]?key|密码|密钥)\s*[=:：]\s*)([^\s,;，；]+)/gi,'$1[已隐藏凭据]').slice(0,4000);}
export function operationLogSnapshot(value:unknown,module:string,depth=0):unknown{
  if(depth>10)return '[超过展示深度]';
  if(value===null||value===undefined)return null;
  if(typeof value==='string')return redactLogText(value);
  if(typeof value==='boolean'||typeof value==='number')return value;
  if(Array.isArray(value)){const items=value.slice(0,3000).map(v=>operationLogSnapshot(v,module,depth+1));
    if(value.length>3000)items.push('[仅展示前 3000 项]');return items;}
  if(typeof value!=='object')return null;
  return Object.fromEntries(Object.entries(value).filter(([key])=>(module==='tickets'?ticketFields:module==='directory'?directoryFields:safeFields).has(key)||module==='roles'&&memberPrivilegeFields.has(key))
    .map(([key,v])=>[key,operationLogSnapshot(v,module,depth+1)]));
}
export function operationLogChanges(before:unknown,after:unknown){
  const changes:{field:string;before:unknown;after:unknown}[]=[];let truncated=false;
  const visit=(a:unknown,b:unknown,path:string)=>{
    if(JSON.stringify(a)===JSON.stringify(b))return;
    if(changes.length>=200){truncated=true;return;}
    if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
      for(const key of new Set([...Object.keys(a),...Object.keys(b)]))visit((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],path?`${path}.${key}`:key);
    }else if(Array.isArray(a)&&Array.isArray(b)&&[...a,...b].every(v=>v&&typeof v==='object'&&typeof (v.id??v.serviceCode)==='string')
      &&[a,b].every(rows=>new Set(rows.map(v=>v.id??v.serviceCode)).size===rows.length)){
      const map=(v:Record<string,unknown>[])=>new Map(v.map(row=>[String(row.id??row.serviceCode),row]));const x=map(a),y=map(b);
      for(const key of new Set([...x.keys(),...y.keys()]))visit(x.get(key),y.get(key),`${path}[${key}]`);
    }else changes.push({field:path||'配置',before:a??null,after:b??null});
  };
  visit(before,after,'');return {changes,changesTruncated:truncated};
}
