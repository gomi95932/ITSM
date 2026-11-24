import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { MANAGED_ROLE_CODES, type RoleBindingInput, type RoleDecisionInput } from '@itsm/contracts';
import { Database } from './database.service.js';
import type { Identity } from './auth.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK, ROLE_EFFECTIVE_SQL, roleReviewDenial } from './role-policy.js';
import { ensureAdminMembership } from './admin-membership.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields=`r.id,r.employee_id AS "employeeId",e.display_name AS "employeeName",r.role_code AS "roleCode",
  r.group_id AS "groupId",g.name AS "groupName",r.valid_from AS "validFrom",r.valid_to AS "validTo",r.status,r.source,
  r.requested_by AS "requestedBy",r.reviewed_by AS "reviewedBy",r.revoked_by AS "revokedBy",r.reason,
  r.review_reason AS "reviewReason",r.revoke_reason AS "revokeReason",r.version,r.created_at AS "createdAt",r.management_mode AS "managementMode",
  (${ROLE_EFFECTIVE_SQL}) AS effective`;
type Access={admin:boolean;groups:string[]};

@Injectable()
export class RolesService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService) {}

  private async access(client:Pick<PoolClient,'query'>,actor:string):Promise<Access> {
    const result=await client.query(`SELECT r.role_code,r.group_id FROM role_bindings r WHERE r.employee_id=$1
      AND r.role_code IN ('PLATFORM_ADMIN','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}`,[actor]);
    const access={admin:result.rows.some(r=>r.role_code==='PLATFORM_ADMIN'),groups:result.rows.filter(r=>r.group_id).map(r=>r.group_id as string)};
    if(!access.admin&&!access.groups.length)throw new NotFoundException();
    return access;
  }

  private async writeAccess(client:PoolClient,actor:string):Promise<Access> {
    await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
      throw new UnauthorizedException({code:'EMPLOYEE_DISABLED'});
    return this.access(client,actor);
  }

  private async row(client:Pick<PoolClient,'query'>,id:string,access:Access) {
    const result=await client.query(`SELECT ${fields} FROM role_bindings r JOIN employees e ON e.id=r.employee_id
      LEFT JOIN support_groups g ON g.id=r.group_id WHERE r.id=$1 AND ($2 OR r.group_id=ANY($3::text[]))`,[id,access.admin,access.groups]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }

  async list(actor:Identity) {
    const access=await this.access(this.db.pool,actor.id);
    const result=await this.db.pool.query(`SELECT ${fields} FROM role_bindings r JOIN employees e ON e.id=r.employee_id
      LEFT JOIN support_groups g ON g.id=r.group_id WHERE $1 OR r.group_id=ANY($2::text[])
      ORDER BY (r.status IN ('PENDING','ACTIVE')) DESC,r.created_at DESC,r.id DESC LIMIT 200`,[access.admin,access.groups]);
    return {items:result.rows,canReview:access.admin};
  }

  async options(actor:Identity,search:unknown) {
    const access=await this.access(this.db.pool,actor.id);
    if(search!==undefined&&(typeof search!=='string'||search.length>100))throw new BadRequestException({code:'INVALID_ROLE_BINDING'});
    const groups=await this.db.pool.query('SELECT id,name FROM support_groups WHERE enabled AND ($1 OR id=ANY($2::text[])) ORDER BY name,id',[access.admin,access.groups]);
    const people=await this.db.pool.query(`SELECT e.id,e.display_name AS name,COALESCE(array_agg(m.group_id) FILTER (WHERE m.group_id IS NOT NULL),'{}') AS groups
      FROM employees e LEFT JOIN group_memberships m ON m.employee_id=e.id AND ($1 OR m.group_id=ANY($2::text[])) WHERE e.active AND ($1 OR e.id<>$3)
      AND ($1 OR EXISTS(SELECT 1 FROM group_memberships x WHERE x.employee_id=e.id AND x.group_id=ANY($2::text[])))
      AND (position(lower($4) in lower(e.display_name))>0 OR position(lower($4) in lower(e.id))>0)
      GROUP BY e.id,e.display_name ORDER BY e.display_name,e.id LIMIT 201`,[access.admin,access.groups,actor.id,(search??'') as string]);
    return {groups:groups.rows,people:people.rows.slice(0,200),hasMore:people.rows.length>200,
      roleCodes:access.admin?MANAGED_ROLE_CODES:MANAGED_ROLE_CODES.filter(code=>code!=='PLATFORM_ADMIN')};
  }

  private async audit(client:PoolClient,id:string,actor:string,action:string,before:object|null,after:object,reason:string) {
    await client.query(`INSERT INTO role_binding_audits(binding_id,actor_id,action,before_value,after_value,reason)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,actor,action,before?JSON.stringify(before):null,JSON.stringify(after),reason]);
    await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,`ROLE_${action}`,id]);
  }

  async propose(actor:Identity,body:unknown,direct=false) {
    const b=body as RoleBindingInput;
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['id','employeeId','roleCode','groupId','validFrom','validTo','reason','contentClass'].includes(k))
      ||typeof b.id!=='string'||!uuid.test(b.id)||typeof b.employeeId!=='string'||!b.employeeId||b.employeeId.length>200
      ||!MANAGED_ROLE_CODES.includes(b.roleCode)||typeof b.validFrom!=='string'||typeof b.validTo!=='string'
      ||!Number.isFinite(Date.parse(b.validFrom))||!Number.isFinite(Date.parse(b.validTo))
      ||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000
      ||(b.roleCode==='PLATFORM_ADMIN'?b.groupId!==null:typeof b.groupId!=='string'||!b.groupId||b.groupId.length>200))
      throw new BadRequestException({code:'INVALID_ROLE_BINDING'});
    await this.intake.requireGeneral(actor.id,b as unknown as Record<string,unknown>,'role-proposal');
    return this.db.transaction(async client=>{
      const access=await this.writeAccess(client,actor.id);
      if(direct&&!access.admin)throw new NotFoundException();
      if(!direct&&b.employeeId===actor.id)throw new ForbiddenException({code:'ROLE_SELF_GRANT_DENIED'});
      if(!access.admin&&(b.roleCode==='PLATFORM_ADMIN'||!access.groups.includes(b.groupId!)))throw new NotFoundException();
      const employee=await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[b.employeeId]);
      if(!employee.rowCount)throw new BadRequestException({code:'ROLE_SUBJECT_UNAVAILABLE'});
      if(!direct&&b.groupId!==null&&!(await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR SHARE',[b.employeeId,b.groupId])).rowCount)
        throw new BadRequestException({code:'ROLE_SUBJECT_UNAVAILABLE'});
      const existing=await client.query('SELECT * FROM role_bindings WHERE id=$1 FOR UPDATE',[b.id]);
      const from=new Date(b.validFrom),to=new Date(b.validTo);
      if(existing.rowCount){
        const row=existing.rows[0];
        if(row.management_mode!==(direct?'ADMIN_DIRECT':'REVIEW')||row.requested_by!==actor.id||row.employee_id!==b.employeeId||row.role_code!==b.roleCode||row.group_id!==b.groupId
          ||row.valid_from.getTime()!==from.getTime()||row.valid_to.getTime()!==to.getTime()||row.reason!==b.reason.trim())
          throw new ConflictException({code:'ROLE_BINDING_ID_CONFLICT'});
        return this.row(client,b.id,access);
      }
      const valid=await client.query(`SELECT $1::timestamptz>=now()-interval '5 minutes' AND $1::timestamptz<=now()+interval '366 days'
        AND $2::timestamptz>$1::timestamptz AND $2::timestamptz<=now()+interval '366 days' AS ok`,[from,to]);
      if(!valid.rows[0].ok)throw new BadRequestException({code:'ROLE_VALIDITY_INVALID'});
      if(direct&&b.groupId!==null)await ensureAdminMembership(client,actor.id,b.employeeId,b.groupId,b.reason.trim());
      const inserted=await client.query(`INSERT INTO role_bindings(id,employee_id,role_code,group_id,valid_from,valid_to,requested_by,reason,
        management_mode,status,reviewed_by,review_reason,reviewed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $11::text IS NOT NULL THEN now() END) ON CONFLICT DO NOTHING RETURNING id`,
        [b.id,b.employeeId,b.roleCode,b.groupId,from,to,actor.id,b.reason.trim(),direct?'ADMIN_DIRECT':'REVIEW',direct?'ACTIVE':'PENDING',
          direct?actor.id:null,direct?b.reason.trim():null]);
      if(!inserted.rowCount)throw new ConflictException({code:'ROLE_BINDING_EXISTS'});
      const result=await this.row(client,b.id,access);
      await this.audit(client,b.id,actor.id,direct?'APPROVED':'PROPOSED',null,result,b.reason.trim());
      return result;
    });
  }

  async decide(actor:Identity,id:string,body:unknown,revoke=false) {
    if(!uuid.test(id))throw new NotFoundException();
    const b=body as RoleDecisionInput;
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!(revoke?['expectedVersion','reason','contentClass']:['expectedVersion','reason','contentClass','decision']).includes(k))
      ||!Number.isInteger(b.expectedVersion)||b.expectedVersion<1||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000
      ||(!revoke&&!['APPROVE','REJECT'].includes(b.decision??'')))throw new BadRequestException({code:'INVALID_ROLE_BINDING'});
    await this.intake.requireGeneral(actor.id,b as unknown as Record<string,unknown>,'role-decision');
    return this.db.transaction(async client=>{
      const access=await this.writeAccess(client,actor.id);
      if(!access.admin)throw new NotFoundException();
      await client.query('SELECT id FROM role_bindings WHERE id=$1 FOR UPDATE',[id]);
      const before=await this.row(client,id,access);
      if(before.version!==b.expectedVersion)throw new ConflictException({code:'ROLE_VERSION_CONFLICT'});
      if(revoke){
        if(!['PENDING','ACTIVE'].includes(before.status))throw new ConflictException({code:'ROLE_STATE_CONFLICT'});
        if(before.roleCode==='PLATFORM_ADMIN'&&before.effective){
          const remaining=await client.query(`SELECT count(DISTINCT r.employee_id)::int AS count FROM role_bindings r
            WHERE r.role_code='PLATFORM_ADMIN' AND r.id<>$1 AND ${ROLE_EFFECTIVE_SQL}`,[id]);
          if(remaining.rows[0].count<2)throw new ConflictException({code:'ROLE_ADMIN_CONTINUITY_REQUIRED'});
        }
        await client.query(`UPDATE role_bindings SET status='REVOKED',revoked_by=$2,revoke_reason=$3,revoked_at=now(),version=version+1 WHERE id=$1`,[id,actor.id,b.reason.trim()]);
      }else{
        const denial=roleReviewDenial(actor.id,before.requestedBy??'',before.employeeId);
        if(denial)throw new ForbiddenException({code:denial});
        if(before.status!=='PENDING')throw new ConflictException({code:'ROLE_STATE_CONFLICT'});
        if(b.decision==='APPROVE'){
          const subject=await client.query('SELECT 1 FROM employees WHERE id=$1 AND active FOR SHARE',[before.employeeId]);
          if(!subject.rowCount)throw new BadRequestException({code:'ROLE_SUBJECT_UNAVAILABLE'});
          if(before.groupId!==null&&!(await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR SHARE',
            [before.employeeId,before.groupId])).rowCount)throw new BadRequestException({code:'ROLE_SUBJECT_UNAVAILABLE'});
          if(new Date(before.validTo).getTime()<=Date.now())throw new ConflictException({code:'ROLE_VALIDITY_INVALID'});
        }
        await client.query(`UPDATE role_bindings SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1 WHERE id=$1`,
          [id,b.decision==='APPROVE'?'ACTIVE':'REJECTED',actor.id,b.reason.trim()]);
      }
      const result=await this.row(client,id,access);
      await this.audit(client,id,actor.id,revoke?'REVOKED':b.decision==='APPROVE'?'APPROVED':'REJECTED',before,result,b.reason.trim());
      return result;
    });
  }

  async history(actor:Identity,id:string) {
    if(!uuid.test(id))throw new NotFoundException();
    const access=await this.access(this.db.pool,actor.id);
    await this.row(this.db.pool,id,access);
    return {items:(await this.db.pool.query(`SELECT a.actor_id AS "actorId",a.action,a.before_value AS "beforeValue",a.after_value AS "afterValue",a.reason,
      a.created_at AS "createdAt",h.execution_principal AS "executionPrincipal",h.authority_ref AS "authorityRef"
      FROM role_binding_audits a LEFT JOIN admin_handoffs h ON h.id=a.handoff_id WHERE a.binding_id=$1 ORDER BY a.created_at,a.id`,[id])).rows};
  }
}
