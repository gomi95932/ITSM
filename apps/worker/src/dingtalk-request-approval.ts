import type { ApprovalObservation,ApprovalSnapshot,RequestApprovalProvider } from './request-approval.js';

type Transport = (path:string,options:{method:'GET'|'POST';token:string;body?:object;signal:AbortSignal})=>Promise<unknown>;
type Settings = {corpId:string;token:(signal:AbortSignal)=>Promise<string>;transport?:Transport};
const endpoint='/v1.0/workflow/processInstances';
const listEndpoint='/v1.0/workflow/processes/instanceIds/query';
const field='ITSM_REQUEST_BINDING';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const str=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
function invalid():never{throw new Error('APPROVAL_PROVIDER_BINDING_UNVERIFIED');}
const success=(value:unknown)=>value===true||value==='true';
const liveTransport:Transport=async(path,options)=>{
  const response=await fetch(`https://api.dingtalk.com${path}`,{
    method:options.method,headers:{'Content-Type':'application/json','x-acs-dingtalk-access-token':options.token},
    ...(options.body?{body:JSON.stringify(options.body)}:{}),signal:options.signal,redirect:'error',
  });
  if(!response.ok)throw new Error('APPROVAL_PROVIDER_UNAVAILABLE');
  return response.json();
};

// This adapter never substitutes local ledger data for values omitted by the provider.
// The process membership query is required because instance details do not include processCode.
export function dingtalkRequestApproval(settings:Settings):RequestApprovalProvider {
  if(!str(settings.corpId))throw new Error('APPROVAL_CORP_NOT_CONFIGURED');
  const transport=settings.transport??liveTransport;
  const call=async(path:string,method:'GET'|'POST',signal:AbortSignal,body?:object)=>{
    const token=await settings.token(signal);
    if(!str(token))throw new Error('APPROVAL_TOKEN_UNAVAILABLE');
    return transport(path,{method,token,body,signal});
  };
  return {
    async create(input,signal){
      if(input.corpId!==settings.corpId||!str(input.snapshot.templateId)||!input.snapshot.approvers.length)invalid();
      const binding={reference:input.reference,corpId:input.corpId,templateId:input.snapshot.templateId,
        serviceCode:input.snapshot.serviceCode,formVersion:input.snapshot.formVersion,
        requestedValidityDays:input.snapshot.requestedValidityDays,request:input.snapshot.request};
      const result=await call(endpoint,'POST',signal,{
        processCode:input.snapshot.templateId,originatorUserId:input.snapshot.applicant.dingUserId,
        approvers:input.snapshot.approvers.map(person=>({actionType:'NONE',userIds:[person.dingUserId]})),
        formComponentValues:[{name:field,value:JSON.stringify(binding)}],
      });
      if(!object(result)||!str(result.instanceId))invalid();
      return {instanceId:result.instanceId};
    },
    async inspect(instanceId,signal):Promise<ApprovalObservation>{
      if(!str(instanceId))invalid();
      const response=await call(`${endpoint}?processInstanceId=${encodeURIComponent(instanceId)}`,'GET',signal);
      if(!object(response)||!success(response.success)||!object(response.result))invalid();
      const result=response.result;
      if(!str(result.originatorUserId)||!Array.isArray(result.approverUserIds)
        ||!result.approverUserIds.every(str)||!Array.isArray(result.formComponentValues)
        ||!str(result.createTime))invalid();
      const fields=result.formComponentValues.filter(value=>object(value)&&value.name===field);
      if(fields.length!==1||!object(fields[0])||!str(fields[0].value))invalid();
      let binding:unknown;
      try{binding=JSON.parse(fields[0].value as string);}catch{invalid();}
      if(!object(binding)||!str(binding.reference)||binding.corpId!==settings.corpId
        ||!str(binding.templateId)||!str(binding.serviceCode)||!Number.isSafeInteger(binding.formVersion)
        ||!Number.isSafeInteger(binding.requestedValidityDays)||!object(binding.request)
        ||!str(binding.request.subject)||typeof binding.request.description!=='string'||!object(binding.request.fields))invalid();
      const time=Date.parse(result.createTime);
      if(!Number.isFinite(time)||time>Date.now()+86400000)invalid();
      const startTime=time-86400000,endTime=time+86400000;
      let cursor=0,found=false;
      const seen=new Set<number>();
      for(let page=0;page<100;page++){
        if(seen.has(cursor))invalid();seen.add(cursor);
        const ids=await call(listEndpoint,'POST',signal,{processCode:binding.templateId,startTime,endTime,maxResults:100,nextToken:cursor});
        if(!object(ids)||!success(ids.success)||!object(ids.result)||!Array.isArray(ids.result.list)
          ||!ids.result.list.every(str))invalid();
        found ||= ids.result.list.includes(instanceId);
        const next=ids.result.nextToken;
        if(next===undefined||next===null||next===''){
          if(!found)invalid();
          const state=result.status==='COMPLETED'&&result.result==='agree'?'APPROVED'
            :result.status==='COMPLETED'&&result.result==='refuse'?'REJECTED'
            :result.status==='RUNNING'?'PENDING'
            :result.status==='TERMINATED'?'WITHDRAWN':invalid();
          return {instanceId,corpId:settings.corpId,templateId:binding.templateId,
            applicantDingUserId:result.originatorUserId,approverDingUserIds:result.approverUserIds,
            state,requestBinding:{reference:binding.reference,serviceCode:binding.serviceCode,
              formVersion:binding.formVersion as number,requestedValidityDays:binding.requestedValidityDays as number,
              request:binding.request as ApprovalSnapshot['request']}};
        }
        const parsed=Number(next);
        if(!Number.isSafeInteger(parsed)||parsed<=cursor)invalid();
        cursor=parsed;
      }
      return invalid();
    },
  };
}
