import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const approvalStates=['QUEUED','CREATING','CREATE_UNCERTAIN','PENDING','APPROVED','REJECTED','WITHDRAWN','EXPIRED','BLOCKED'];
const fulfillmentStates=['READY','DELIVERED','REVOKE_DUE','REVOKED','BLOCKED'];

// These fixtures exercise display/authorization only, never real OA or downstream grants.
export async function createRequestProgressFixture({approvalState=null,fulfillmentState=null}={}) {
  if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
  if((approvalState!==null&&!approvalStates.includes(approvalState))
    ||(fulfillmentState!==null&&!fulfillmentStates.includes(fulfillmentState))
    ||(fulfillmentState&&approvalState!=='APPROVED'&&!(fulfillmentState==='BLOCKED'&&approvalState==='BLOCKED')))
    throw new Error('INVALID_PROGRESS_FIXTURE_STATE');
  const id=randomUUID(),code=`REQ-PROGRESS-${id}`,subject=`Request progress ${id.slice(0,8)}`;
  const internalMarker=`private-oa-binding-${id}`;
  const corp=`ci-progress-${id}`;
  const snapshot={
    serviceCode:code,formVersion:1,templateId:internalMarker,requestedValidityDays:1,
    applicant:{employeeId:'employee-1',dingUserId:'progress-applicant'},
    approvers:[{employeeId:'agent-3',dingUserId:'progress-approver',role:'SERVICE_OWNER'}],
    catalog:{},request:{subject,description:'CI-only synthetic request',fields:{}},
    internalBinding:internalMarker,
  };
  const now=Date.now(),updatedAt=new Date(now).toISOString();
  const delivered=['DELIVERED','REVOKE_DUE','REVOKED'].includes(fulfillmentState);
  const deliveredAt=delivered?new Date(now-60000).toISOString():null;
  const accessExpiresAt=delivered?new Date(now+(fulfillmentState==='DELIVERED'?3600000:-10000)).toISOString():null;
  const reviewedAt=delivered?new Date(now-30000).toISOString():null;
  const revokedAt=fulfillmentState==='REVOKED'?updatedAt:null;
  const literal=value=>value===null?'NULL':`'${value.replaceAll("'","''")}'`;
  const query=`BEGIN;
    INSERT INTO identity_links(corp_id,ding_user_id,employee_id)
      VALUES ('${corp}','progress-applicant','employee-1'),('${corp}','progress-approver','agent-3');
    INSERT INTO service_catalog(code,type,form_version,published,group_id,name,description,required_fields,field_schema,visible_groups)
      VALUES ('${code}','REQ',1,true,'service-desk','Progress CI fixture','CI-only request catalog','[]','[]','[]');
    INSERT INTO tickets(id,number,requester_id,owner_group_id,service_code,service_type,form_version,subject,description,fields,
      impact,urgency,priority,status,submitted_by_id)
      VALUES ('${id}','REQ-${id}','employee-1','service-desk','${code}','REQ',1,'${subject}',
        'CI-only synthetic request','{}','INDIVIDUAL','LOW','P3','WAITING_APPROVAL','employee-1');
    ${approvalState?`
    INSERT INTO request_approvals(ticket_id,corp_id,snapshot,expires_at,state,provider_instance_id,last_verified_at,next_at,updated_at,last_error)
      VALUES ('${id}','${corp}',${literal(JSON.stringify(snapshot))},now()+interval '1 day',
        '${approvalState}','${internalMarker}',${approvalState==='APPROVED'?literal(updatedAt):'NULL'},
        now()+interval '1 day','${updatedAt}','${internalMarker}');`:''}
    ${fulfillmentState?`
    INSERT INTO request_fulfillments(approval_id,ticket_id,assignee_id,ready_until,state,delivered_at,access_expires_at,
      revoked_at,reviewed_at,reviewed_by,updated_at,reason_code)
      SELECT id,'${id}','agent-1',now()+interval '1 day','${fulfillmentState}',${literal(deliveredAt)},
        ${literal(accessExpiresAt)},${literal(revokedAt)},${literal(reviewedAt)},${reviewedAt?"'agent-3'":'NULL'},
        '${updatedAt}','${internalMarker}' FROM request_approvals WHERE ticket_id='${id}';`:''}
    INSERT INTO group_memberships(employee_id,group_id) VALUES ('agent-1','service-desk') ON CONFLICT DO NOTHING;
    COMMIT;`;
  await new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
    {stdio:['ignore','ignore','pipe']});
    child.stderr.resume();child.once('error',reject);
    child.once('close',status=>status===0?resolve():reject(new Error('REQUEST_PROGRESS_FIXTURE_SQL_FAILED')));
  });
  return {id,subject,internalMarker,progress:{
    approval:approvalState?{state:approvalState,updatedAt}:null,
    fulfillment:fulfillmentState?{state:fulfillmentState,deliveredAt,accessExpiresAt,revokedAt,reviewedAt,updatedAt}:null,
  }};
}
