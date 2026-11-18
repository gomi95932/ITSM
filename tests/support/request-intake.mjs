import { spawn } from 'node:child_process';

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
  return snapshot;
}
