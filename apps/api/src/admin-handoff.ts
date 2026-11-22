import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL } from './role-policy.js';

export type HandoffSelection={
  requestId:string;corpId:string;roots:number[];pilotUserIds:string[];
  admins:{userId:string;name:string}[];previousBindingIds:string[];
  executionPrincipal:string;authorityRef:string;reason:string;configurationSha256:string;backupRef:string;validUntil:string;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
function requireCondition(value:unknown,code:string):asserts value{if(!value)throw new Error(code);}

export function validateHandoff(input:unknown):HandoffSelection {
  const b=input as HandoffSelection;
  requireCondition(b&&typeof b==='object'&&!Array.isArray(b),'HANDOFF_SELECTION_INVALID');
  const keys=['requestId','corpId','roots','pilotUserIds','admins','previousBindingIds','executionPrincipal','authorityRef','reason','configurationSha256','backupRef','validUntil'];
  requireCondition(Object.keys(b).length===keys.length&&keys.every(k=>Object.hasOwn(b,k)),'HANDOFF_SELECTION_INVALID');
  requireCondition(uuid.test(b.requestId)&&text(b.corpId,200)&&Array.isArray(b.roots)&&b.roots.length>0&&b.roots.length<=10
    &&b.roots.every(r=>Number.isSafeInteger(r)&&r>0)&&new Set(b.roots).size===b.roots.length,'HANDOFF_SELECTION_INVALID');
  requireCondition(Array.isArray(b.pilotUserIds)&&b.pilotUserIds.length>=2&&b.pilotUserIds.length<=30
    &&b.pilotUserIds.every(id=>text(id,200))&&new Set(b.pilotUserIds).size===b.pilotUserIds.length,'HANDOFF_SELECTION_INVALID');
  requireCondition(Array.isArray(b.admins)&&b.admins.length===2&&b.admins.every(a=>a&&Object.keys(a).length===2
    &&text(a.userId,200)&&text(a.name,200)&&b.pilotUserIds.includes(a.userId))&&b.admins[0].userId!==b.admins[1].userId,'HANDOFF_SELECTION_INVALID');
  requireCondition(Array.isArray(b.previousBindingIds)&&b.previousBindingIds.length===2&&b.previousBindingIds.every(id=>uuid.test(id))
    &&new Set(b.previousBindingIds).size===2,'HANDOFF_SELECTION_INVALID');
  requireCondition(text(b.executionPrincipal,200)&&text(b.authorityRef,500)&&text(b.reason,1000)
    &&/^[a-f0-9]{64}$/.test(b.configurationSha256)&&text(b.backupRef,1000),'HANDOFF_SELECTION_INVALID');
  requireCondition(text(b.validUntil,40),'HANDOFF_VALIDITY_INVALID');
  const expiry=Date.parse(b.validUntil);
  requireCondition(Number.isFinite(expiry)&&expiry>Date.now()+86400000&&expiry<=Date.now()+365*86400000,'HANDOFF_VALIDITY_INVALID');
  return b;
}

// This offline maintenance path records the actual executor, never an invented human review.
// The caller owns BEGIN/COMMIT; both authorization and directory writes are locked here.
export async function handoffAdministrators(client:PoolClient,input:unknown,apply=false){
  const b=validateHandoff(input);
  await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
  requireCondition(!(await client.query('SELECT 1 FROM admin_handoffs LIMIT 1')).rowCount,'HANDOFF_ALREADY_COMPLETED');
  const scope=createHash('sha256').update(JSON.stringify([b.corpId,[...b.roots].sort((a,c)=>a-c),[...b.pilotUserIds].sort()])).digest('hex');
  const run=await client.query(`SELECT id FROM directory_sync_runs WHERE corp_id=$1 AND scope_hash=$2 AND state='SUCCEEDED'
    AND people_count=$3 AND disabled_count=0 AND completed_at>clock_timestamp()-interval '15 minutes'
    ORDER BY completed_at DESC LIMIT 1 FOR SHARE`,[b.corpId,scope,b.pilotUserIds.length]);
  requireCondition(run.rowCount===1,'HANDOFF_RECENT_DIRECTORY_REQUIRED');
  const people=await client.query(`SELECT e.id,e.display_name,p.ding_user_id FROM directory_people p
    JOIN identity_links l ON l.corp_id=p.corp_id AND l.ding_user_id=p.ding_user_id AND l.employee_id=p.employee_id
    JOIN employees e ON e.id=p.employee_id WHERE p.corp_id=$1 AND p.scope_hash=$2 AND p.last_seen_run=$3
    AND p.ding_user_id=ANY($4::text[]) AND e.active FOR UPDATE OF e,p,l`,[b.corpId,scope,run.rows[0].id,b.pilotUserIds]);
  requireCondition(people.rowCount===b.pilotUserIds.length,'HANDOFF_DIRECTORY_IDENTITY_MISMATCH');
  const admins=b.admins.map(a=>people.rows.find(p=>p.ding_user_id===a.userId&&p.display_name===a.name));
  requireCondition(admins.every(Boolean)&&new Set(admins.map(a=>a.id)).size===2,'HANDOFF_ADMIN_IDENTITY_MISMATCH');
  const old=await client.query(`SELECT r.* FROM role_bindings r WHERE role_code='PLATFORM_ADMIN'
    AND status IN ('PENDING','ACTIVE') ORDER BY id FOR UPDATE`);
  requireCondition(old.rowCount===2&&old.rows.every(r=>b.previousBindingIds.includes(r.id)&&r.source==='BOOTSTRAP'
    &&r.status==='ACTIVE'&&/^demo-admin-[0-9]+$/.test(r.employee_id)),'HANDOFF_DEMO_BASELINE_CHANGED');
  const oldPeople=old.rows.map(r=>r.employee_id);
  requireCondition(new Set(oldPeople).size===2,'HANDOFF_DEMO_BASELINE_CHANGED');
  await client.query('SELECT id FROM employees WHERE id=ANY($1::text[]) FOR UPDATE',[oldPeople]);
  requireCondition(!(await client.query(`SELECT 1 FROM identity_links WHERE employee_id=ANY($1::text[])
    UNION ALL SELECT 1 FROM oidc_identity_links WHERE employee_id=ANY($1::text[]) LIMIT 1`,[oldPeople])).rowCount,'HANDOFF_DEMO_HAS_REAL_IDENTITY');
  const plan={state:apply?'APPLIED':'PREVIEW',requestId:b.requestId,admins:admins.map(a=>({employeeId:a.id,name:a.display_name})),
    previousEmployeeIds:oldPeople,directoryRunId:run.rows[0].id,validUntil:b.validUntil};
  if(!apply)return plan;
  await client.query(`INSERT INTO admin_handoffs(id,execution_principal,authority_ref,reason,directory_run_id,configuration_sha256,backup_ref,selection)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[b.requestId,b.executionPrincipal,b.authorityRef,b.reason,run.rows[0].id,b.configurationSha256,b.backupRef,JSON.stringify(b)]);
  for(const person of admins){
    const row=(await client.query(`INSERT INTO role_bindings(id,employee_id,role_code,valid_from,valid_to,status,source,reason,handoff_id)
      VALUES($1,$2,'PLATFORM_ADMIN',now(),$3,'ACTIVE','HANDOFF',$4,$5) RETURNING *`,[randomUUID(),person.id,b.validUntil,b.reason,b.requestId])).rows[0];
    await client.query(`INSERT INTO role_binding_audits(binding_id,action,after_value,reason,handoff_id)
      VALUES($1,'HANDED_OFF',$2,$3,$4)`,[row.id,JSON.stringify(row),b.reason,b.requestId]);
  }
  const revoked=[];
  const bindings=await client.query(`SELECT * FROM role_bindings WHERE employee_id=ANY($1::text[]) AND status IN ('ACTIVE','PENDING') FOR UPDATE`,[oldPeople]);
  for(const before of bindings.rows){
    const after=(await client.query(`UPDATE role_bindings SET status='REVOKED',revoked_by=NULL,revoke_reason=$2,
      revoked_at=now(),version=version+1 WHERE id=$1 RETURNING *`,[before.id,b.reason])).rows[0];
    await client.query(`INSERT INTO role_binding_audits(binding_id,action,before_value,after_value,reason,handoff_id)
      VALUES($1,'HANDOFF_REVOKED',$2,$3,$4,$5)`,[after.id,JSON.stringify(before),JSON.stringify(after),b.reason,b.requestId]);
    revoked.push(after.id);
  }
  await client.query('UPDATE employees SET active=false WHERE id=ANY($1::text[])',[oldPeople]);
  await client.query('DELETE FROM auth_sessions WHERE employee_id=ANY($1::text[])',[oldPeople]);
  const effective=await client.query(`SELECT employee_id FROM role_bindings r WHERE role_code='PLATFORM_ADMIN' AND ${ROLE_EFFECTIVE_SQL}`);
  requireCondition(effective.rowCount===2&&effective.rows.every(r=>admins.some(a=>a.id===r.employee_id)),'HANDOFF_POSTCONDITION_FAILED');
  return {...plan,revokedBindingIds:revoked};
}
