import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const literal=value=>value===null?'NULL':`'${String(value).replaceAll("'","''")}'`;
export async function fulfillmentSql(query,success=true) {
  if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -Atc "$1"','sh',query],
    {stdio:['ignore','pipe','pipe']});
    let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
    child.once('error',reject);child.once('close',code=>success
      ?code===0?resolve(output.trim()):reject(new Error(`FULFILLMENT_FIXTURE_SQL_FAILED: ${error.slice(0,1000)}`))
      :resolve({code,error}));
  });
}

// CI-only synthetic records, with no external OA request or downstream permission grant.
export async function createFulfillmentFixture({groupId=`fulfillment-${randomUUID()}`,state='DELIVERED',
  appointed=false,includeApplicant=false,history=0,reviewed=false}={}) {
  if(!['READY','DELIVERED','REVOKE_DUE','REVOKED','BLOCKED'].includes(state))throw new Error('INVALID_FULFILLMENT_FIXTURE');
  const ticketId=randomUUID(),approvalId=randomUUID(),id=randomUUID(),positionId=`position-${id}`,domainId=`domain-${id}`;
  const serviceCode=`REQ-FW-${randomUUID().replaceAll('-','').slice(0,24).toUpperCase()}`,corp=`ci-fw-${id}`,subject=`交付验证 ${id.slice(0,8)}`;
  const internalMarker=`private-oa-binding-${id}`,deliveryReference=`DELIVERY-${id}`;
  const delivered=['DELIVERED','REVOKE_DUE','REVOKED'].includes(state);
  const config={domains:[{id:domainId,name:'交付验证域',enabled:true}],systems:[],
    positions:[{id:positionId,name:'交付验证岗位',domainId,groupId,enabled:true}],
    appointments:['agent-1','agent-2'].map(employeeId=>({id:randomUUID(),positionId,employeeId,duty:'PRIMARY',enabled:true,
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString()})),mappings:[]};
  const routing=appointed?{primaryPositionId:positionId,positions:[{id:positionId,groupId}]}:{};
  const snapshot={serviceCode,formVersion:1,templateId:internalMarker,requestedValidityDays:1,
    applicant:{employeeId:'employee-1',dingUserId:`applicant-${id}`},
    approvers:[{employeeId:'agent-3',dingUserId:`approver-${id}`,role:'SERVICE_OWNER'}],
    catalog:{},request:{subject,description:'CI-only synthetic fulfillment',fields:{}},internalBinding:internalMarker};
  const members=['agent-1','agent-2','agent-3',...(includeApplicant?['employee-1']:[])];
  await fulfillmentSql(`BEGIN;
    INSERT INTO support_groups(id,name) VALUES(${literal(groupId)},'交付验证组') ON CONFLICT DO NOTHING;
    INSERT INTO group_memberships(employee_id,group_id) VALUES ${members.map(employee=>`(${literal(employee)},${literal(groupId)})`).join(',')}
      ON CONFLICT DO NOTHING;
    INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,requested_by,reviewed_by,reason)
      SELECT '${randomUUID()}','agent-3','GROUP_LEAD',${literal(groupId)},now()-interval '1 day',now()+interval '1 day',
        'ACTIVE','REVIEW','demo-admin-1','demo-admin-2','CI-only reviewed lead fixture'
      WHERE NOT EXISTS(SELECT 1 FROM role_bindings WHERE employee_id='agent-3' AND group_id=${literal(groupId)} AND role_code='GROUP_LEAD' AND status='ACTIVE');
    INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES
      (${literal(corp)},${literal(`applicant-${id}`)},'employee-1'),(${literal(corp)},${literal(`approver-${id}`)},'agent-3');
    INSERT INTO service_catalog(code,type,form_version,published,group_id,name,description,required_fields,field_schema,visible_groups)
      VALUES(${literal(serviceCode)},'REQ',1,true,${literal(groupId)},'交付生命周期验证','CI-only request','[]','[]','[]');
    INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,form_version,
      subject,description,fields,impact,urgency,priority,status,service_routing_snapshot)
      VALUES('${ticketId}',${literal(`REQ-${ticketId}`)},'employee-1','employee-1',${literal(groupId)},${literal(serviceCode)},'REQ',1,
        ${literal(subject)},'CI-only synthetic fulfillment','{}','INDIVIDUAL','LOW','P3','WAITING_APPROVAL',${literal(JSON.stringify(routing))});
    INSERT INTO request_approvals(id,ticket_id,corp_id,snapshot,expires_at,state,provider_instance_id,last_verified_at,next_at,last_error)
      VALUES('${approvalId}','${ticketId}',${literal(corp)},${literal(JSON.stringify(snapshot))},now()+interval '1 day','APPROVED',
        ${literal(internalMarker)},now(),now()+interval '1 day',${literal(internalMarker)});
    INSERT INTO request_fulfillments(id,approval_id,ticket_id,assignee_id,ready_until,state,delivered_at,access_expires_at,
      reviewed_at,reviewed_by,revoked_at,reason_code)
      VALUES('${id}','${approvalId}','${ticketId}','agent-1',now()+interval '1 day','${state}',
        ${delivered?"now()-interval '1 minute'":'NULL'},${delivered?state==='DELIVERED'?"now()+interval '1 hour'":"now()-interval '30 seconds'":'NULL'},
        ${reviewed?"now()-interval '20 seconds'":'NULL'},${reviewed?"'agent-2'":'NULL'},${state==='REVOKED'?'now()':'NULL'},${literal(internalMarker)});
    ${delivered?`INSERT INTO request_fulfillment_events(fulfillment_id,actor_id,action,to_state,evidence_reference)
      VALUES('${id}','agent-1','DELIVERY_RECORDED','${state}',${literal(deliveryReference)});`:''}
    ${history?`INSERT INTO request_fulfillment_events(fulfillment_id,action,to_state,created_at)
      SELECT '${id}','CI_HISTORY','${state}',now()-n*interval '1 second' FROM generate_series(1,${Number(history)}) n;`:''}
    ${appointed?`SELECT version FROM service_structure_current WHERE id FOR UPDATE;
      INSERT INTO service_structure_versions(version,config)
        SELECT v.version+1,jsonb_build_object(${['domains','systems','positions','appointments','mappings'].map(key=>
          `'${key}',(v.config->'${key}')||${literal(JSON.stringify(config[key]))}::jsonb`).join(',')})
        FROM service_structure_current c JOIN service_structure_versions v ON v.version=c.version WHERE c.id;
      UPDATE service_structure_current SET version=version+1 WHERE id;`:''}
    COMMIT;`);
  return {id,ticketId,approvalId,groupId,positionId,subject,serviceCode,internalMarker,deliveryReference};
}
