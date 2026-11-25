import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const intakeCorp='ci-intake-corp';
export const requester='ci-intake-requester';
export const manager='ci-intake-manager';
export const owner='ci-intake-owner';
export const verifier='ci-intake-verifier';
export const incidentCode='INC-INTAKE-CI';
export const quote=value=>`'${String(value).replaceAll("'","''")}'`;

export async function sql(query) {
  if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
  return new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','db','sh','-ec',
      'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -v ON_ERROR_STOP=1 -U itsm -d itsm -qAtc "$1"','sh',query],
    {stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.resume();child.once('error',reject);
    child.once('close',code=>code===0?resolve(output.trim()):reject(new Error('REQUEST_INTAKE_SQL_FAILED')));
  });
}

export async function seedIntake({browser=false}={}) {
  const code=browser?'REQ-INTAKE-UI':'REQ-INTAKE-CI';
  const applicant=browser?'employee-1':requester;
  const snapshot={code,formVersion:1,published:true,name:browser?'试点权限申请':'CI request intake',
    description:'Synthetic request intake validation',groupId:'service-desk',visibleGroups:[],maxValidityDays:90,
    fields:[{key:'system',label:'目标系统',required:true,options:['ERP','WMS']},{key:'reason',label:'申请用途',required:true}],
    approval:{templateId:'CI-ONLY',steps:[{role:'MANAGER'},{role:'SYSTEM_OWNER',approverId:owner}]}};
  await sql(`BEGIN;
    INSERT INTO employees(id,display_name,active)
      SELECT id,id,true FROM unnest(ARRAY[${[requester,manager,owner,verifier].map(quote).join(',')}]) AS people(id)
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO identity_links(corp_id,ding_user_id,employee_id)
      SELECT ${quote(intakeCorp)},id,id FROM unnest(ARRAY[${[applicant,manager,owner].map(quote).join(',')}]) AS people(id)
      ON CONFLICT DO NOTHING;
    INSERT INTO request_manager_mappings(employee_id,manager_id,source_reference,verified_by,review_before)
      VALUES (${quote(applicant)},${quote(manager)},'ci synthetic manager',${quote(verifier)},now()+interval '2 days')
      ON CONFLICT (employee_id) DO UPDATE SET manager_id=EXCLUDED.manager_id,source_reference=EXCLUDED.source_reference,
        verified_by=EXCLUDED.verified_by,verified_at=EXCLUDED.verified_at,review_before=EXCLUDED.review_before;
    INSERT INTO service_catalog(code,type,form_version,published,group_id,name,description,required_fields,field_schema,visible_groups)
      VALUES (${quote(code)},'REQ',1,true,'service-desk',${quote(snapshot.name)},${quote(snapshot.description)},
        '["system","reason"]',${quote(JSON.stringify(snapshot.fields))},'[]') ON CONFLICT (code) DO NOTHING;
    INSERT INTO service_catalog(code,type,form_version,published,group_id,name,description,required_fields,field_schema,visible_groups)
      VALUES (${quote(incidentCode)},'INC',1,true,'service-desk','CI intake incident','Synthetic incident validation','[]','[]','[]')
      ON CONFLICT (code) DO NOTHING;
    INSERT INTO request_catalog_versions(service_code,form_version,snapshot,published_by)
      VALUES (${quote(code)},1,${quote(JSON.stringify(snapshot))},${quote(verifier)}) ON CONFLICT DO NOTHING;
    COMMIT;`);
  const base='http://127.0.0.1:8088/api/v1/admin/catalog-navigation/tree';
  const headers={'Content-Type':'application/json','X-Dev-User':'demo-admin-1'};
  const response=await fetch(base,{headers});
  if(!response.ok)throw new Error(`REQUEST_INTAKE_DIRECTORY_READ_FAILED:${response.status}`);
  const tree=await response.json();
  const root=tree.nodes.find(node=>node.kind==='CATEGORY'&&node.parentId===null&&node.name==='其他服务');
  if(!root)throw new Error('REQUEST_INTAKE_DIRECTORY_ROOT_MISSING');
  const nodes=structuredClone(tree.nodes);
  const available=new Set(tree.systems.filter(item=>item.enabled).map(item=>item.id));
  for(const node of nodes){
    if(node.kind==='SYSTEM'&&node.systemId&&!available.has(node.systemId))node.enabled=false;
  }
  for(const node of nodes){
    if(node.parentId&&nodes.some(parent=>parent.id===node.parentId&&!parent.enabled))node.enabled=false;
  }
  const information=nodes.find(node=>node.kind==='CATEGORY'&&node.parentId===null&&node.name==='信息化系统');
  const publishedCodes=new Set(nodes.filter(node=>node.serviceCode).map(node=>node.serviceCode));
  // Earlier CI fixtures insert catalog rows directly; the directory editor requires a complete snapshot.
  for(const service of tree.services){
    if(publishedCodes.has(service.code)||service.code===code||service.code===incidentCode)continue;
    let parent=root;
    if(service.systemId){
      if(!information)throw new Error('REQUEST_INTAKE_INFORMATION_ROOT_MISSING');
      parent=nodes.find(node=>node.kind==='SYSTEM'&&node.systemId===service.systemId);
      if(!parent){
        parent={id:`system-${randomUUID()}`,parentId:information.id,kind:'SYSTEM',
          name:`CI system ${service.systemId}`.slice(0,80),enabled:false,sortOrder:900,
          systemId:service.systemId,serviceCode:null};
        nodes.push(parent);
      }
    }
    nodes.push({id:`service-${randomUUID()}`,parentId:parent.id,kind:'SERVICE',
      name:`CI fixture ${service.code}`.slice(0,80),enabled:false,sortOrder:900,
      systemId:null,serviceCode:service.code});
    publishedCodes.add(service.code);
  }
  for(const [serviceCode,name] of [[code,snapshot.name],[incidentCode,'CI intake incident']]){
    if(nodes.some(node=>node.serviceCode===serviceCode))continue;
    nodes.push({id:`service-${randomUUID()}`,parentId:root.id,kind:'SERVICE',name,enabled:true,
      sortOrder:900,systemId:null,serviceCode});
  }
  const published=await fetch(base,{method:'POST',headers:{...headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({
    contentClass:'GENERAL',expectedVersion:tree.version,navigationVersion:tree.navigationVersion,
    structureVersion:tree.structureVersion,nodes,reason:'Publish disposable CI request intake services'
  })});
  if(!published.ok)throw new Error(`REQUEST_INTAKE_DIRECTORY_PUBLISH_FAILED:${published.status}:${JSON.stringify(await published.json())}`);
  return snapshot;
}
