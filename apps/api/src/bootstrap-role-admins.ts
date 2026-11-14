import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Database } from './database.service.js';
import { ROLE_AUTHORIZATION_LOCK } from './role-policy.js';

async function main() {
  const db=new Database();
  try {
  const {values}=parseArgs({options:{first:{type:'string'},second:{type:'string'},reason:{type:'string'}},strict:true});
  if(process.env.ITSM_ROLE_BOOTSTRAP_CONFIRM!=='INITIAL_TWO_ADMINS'||!values.first||!values.second||values.first===values.second
    ||values.first.length>200||values.second.length>200||!values.reason?.trim()||values.reason.length>1000)
    throw new Error('BOOTSTRAP_ARGUMENTS_OR_CONFIRMATION_REQUIRED');
  const ids=[values.first,values.second],reason=values.reason.trim();
  const created=await db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
    if((await client.query("SELECT 1 FROM role_bindings WHERE role_code='PLATFORM_ADMIN' LIMIT 1")).rowCount)
      throw new Error('BOOTSTRAP_ALREADY_USED');
    const active=await client.query('SELECT id FROM employees WHERE id=ANY($1::text[]) AND active ORDER BY id FOR SHARE',[ids]);
    if(active.rowCount!==2)throw new Error('BOOTSTRAP_REQUIRES_TWO_ACTIVE_EMPLOYEES');
    const grants=[];
    for(let i=0;i<2;i++){
      const result=await client.query(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,status,source,requested_by,reviewed_by,reason,reviewed_at)
        VALUES($1,$2,'PLATFORM_ADMIN',NULL,now(),now()+interval '365 days','ACTIVE','BOOTSTRAP',$2,$3,$4,now()) RETURNING *`,[randomUUID(),ids[i],ids[1-i],reason]);
      const row=result.rows[0];
      await client.query(`INSERT INTO role_binding_audits(binding_id,actor_id,action,after_value,reason) VALUES($1,$2,'BOOTSTRAPPED',$3,$4)`,[row.id,ids[1-i],JSON.stringify(row),reason]);
      await client.query("INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,'ROLE_BOOTSTRAPPED',$2)",[ids[1-i],row.id]);
      grants.push({id:row.id,employeeId:ids[i]});
    }
    return grants;
  });
  console.log(JSON.stringify({status:'BOOTSTRAPPED',grants:created}));
} catch(error) {
  // Do not print database errors, SQL, connection strings or arguments.
  const known=['BOOTSTRAP_ARGUMENTS_OR_CONFIRMATION_REQUIRED','BOOTSTRAP_ALREADY_USED','BOOTSTRAP_REQUIRES_TWO_ACTIVE_EMPLOYEES'];
  console.error(error instanceof Error&&known.includes(error.message)?error.message:'ROLE_BOOTSTRAP_FAILED');process.exitCode=1;
  } finally {await db.onModuleDestroy();}
}
void main();
