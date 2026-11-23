import { BadRequestException } from '@nestjs/common';
import { createHash,randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

// Called only inside an administrator-authorized transaction holding the role lock.
export async function ensureAdminMembership(client:PoolClient,actor:string,employee:string,group:string,reason:string){
  if(!(await client.query(`SELECT 1 FROM employees e CROSS JOIN support_groups g
    WHERE e.id=$1 AND e.active AND g.id=$2 AND g.enabled FOR SHARE OF e,g`,[employee,group])).rowCount)
    throw new BadRequestException({code:'SUPPORT_PERSON_UNAVAILABLE'});
  if((await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[employee,group])).rowCount)return;
  const id=randomUUID(),basis=reason.slice(0,500);
  const version=(await client.query('SELECT administration_version FROM support_groups WHERE id=$1 FOR UPDATE',[group])).rows[0].administration_version;
  await client.query(`INSERT INTO support_structure_proposals(id,kind,group_id,employee_id,config,expected_group_version,request_hash,
    proposed_by,reviewed_by,status,reason,review_reason,reviewed_at,version,management_mode)
    VALUES($1,'MEMBER_ADD',$2,$3,'{}',$4,$5,$6,$6,'APPROVED',$7,$7,now(),2,'ADMIN_DIRECT')`,
    [id,group,employee,version,createHash('sha256').update(JSON.stringify({actor,employee,group,reason})).digest('hex'),actor,basis]);
  await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2)',[employee,group]);
  await client.query('UPDATE support_groups SET administration_version=administration_version+1 WHERE id=$1',[group]);
  await client.query(`INSERT INTO support_structure_audits(proposal_id,actor_id,action,before_value,after_value,reason)
    VALUES($1,$2,'APPROVED',$3,$4,$5)`,[id,actor,JSON.stringify({employeeId:employee,groupId:group,membership:false}),
      JSON.stringify({employeeId:employee,groupId:group,membership:true,managementMode:'ADMIN_DIRECT'}),basis]);
  await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,'SUPPORT_ADMIN_DIRECT',id]);
}
