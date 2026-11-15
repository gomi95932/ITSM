import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { MembershipChangeInput, MembershipReviewInput, SupportGroupInput, SupportGroupUpdateInput } from '@itsm/contracts';
import { Database } from './database.service.js';
import type { Identity } from './auth.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK, ROLE_EFFECTIVE_SQL } from './role-policy.js';

type Query=Pick<PoolClient,'query'>;
type Access={admin:boolean;groups:string[]};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const groupCode=/^[a-z][a-z0-9-]{2,59}$/;
const changeFields=`c.id,c.group_id AS "groupId",c.employee_id AS "employeeId",e.display_name AS "employeeName",
  c.operation,c.group_version AS "groupVersion",c.status,c.requested_by AS "requestedBy",c.reviewed_by AS "reviewedBy",
  c.reason,c.review_reason AS "reviewReason",c.version,c.created_at AS "createdAt"`;

function object(body:unknown,keys:string[]):Record<string,unknown> {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))
    throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
  return body as Record<string,unknown>;
}
function reason(b:Record<string,unknown>) {
  if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000)throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
}
function name(b:Record<string,unknown>) {
  if(typeof b.name!=='string'||!b.name.trim()||b.name.length>80)throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
}

@Injectable()
export class SupportGroupsService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService) {}

  private async access(client:Query,actor:string,write=false):Promise<Access> {
    if(write){
      await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
      if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
        throw new UnauthorizedException({code:'EMPLOYEE_DISABLED'});
    }
    const rows=(await client.query(`SELECT r.role_code,r.group_id FROM role_bindings r WHERE r.employee_id=$1
      AND r.role_code IN ('PLATFORM_ADMIN','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}`,[actor])).rows;
    const result={admin:rows.some(r=>r.role_code==='PLATFORM_ADMIN'),groups:rows.filter(r=>r.group_id).map(r=>r.group_id as string)};
    if(!result.admin&&!result.groups.length)throw new NotFoundException();
    return result;
  }
  private async group(client:Query,id:string,access:Access,lock=false) {
    if(!access.admin&&!access.groups.includes(id))throw new NotFoundException();
    const result=await client.query(`SELECT id,name,version FROM support_groups WHERE id=$1${lock?' FOR UPDATE':''}`,[id]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }
  private async change(client:Query,group:string,id:string) {
    const result=await client.query(`SELECT ${changeFields} FROM group_membership_changes c JOIN employees e ON e.id=c.employee_id
      WHERE c.group_id=$1 AND c.id=$2`,[group,id]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }
  private async audit(client:PoolClient,group:string,actor:string,action:string,before:object|null,after:object,why:string,change:string|null=null) {
    await client.query(`INSERT INTO support_group_audits(group_id,change_id,actor_id,action,before_value,after_value,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[group,change,actor,action,before?JSON.stringify(before):null,JSON.stringify(after),why]);
    await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,`GROUP_${action}`,change??group]);
  }

  async list(actor:Identity) {
    const access=await this.access(this.db.pool,actor.id);
    const result=await this.db.pool.query(`SELECT g.id,g.name,g.version,
      (SELECT count(*)::int FROM group_memberships m JOIN employees e ON e.id=m.employee_id AND e.active WHERE m.group_id=g.id) AS "activeMembers",
      (SELECT count(*)::int FROM group_membership_changes c WHERE c.group_id=g.id AND c.status='PENDING') AS "pendingChanges"
      FROM support_groups g WHERE $1 OR g.id=ANY($2::text[]) ORDER BY g.name,g.id`,[access.admin,access.groups]);
    return {items:result.rows,canConfigure:access.admin,canReview:access.admin};
  }
  async people(actor:Identity,search:unknown) {
    await this.access(this.db.pool,actor.id);
    if(typeof search!=='string'||search.trim().length<2||search.length>100)throw new BadRequestException({code:'GROUP_PEOPLE_SEARCH_REQUIRED'});
    const result=await this.db.pool.query(`SELECT id,display_name AS name FROM employees WHERE active AND id<>$1
      AND (position(lower($2) in lower(display_name))>0 OR position(lower($2) in lower(id))>0)
      ORDER BY display_name,id LIMIT 51`,[actor.id,search.trim()]);
    return {items:result.rows.slice(0,50),hasMore:result.rows.length>50};
  }
  async detail(actor:Identity,id:string) {
    const access=await this.access(this.db.pool,actor.id);
    const group=await this.group(this.db.pool,id,access);
    const members=await this.db.pool.query(`SELECT e.id,e.display_name AS name,e.active,
      ARRAY(SELECT DISTINCT r.role_code FROM role_bindings r WHERE r.employee_id=e.id AND r.group_id=$1 AND ${ROLE_EFFECTIVE_SQL} ORDER BY r.role_code) AS roles
      FROM group_memberships m JOIN employees e ON e.id=m.employee_id WHERE m.group_id=$1 ORDER BY e.display_name,e.id`,[id]);
    const changes=await this.db.pool.query(`SELECT ${changeFields} FROM group_membership_changes c JOIN employees e ON e.id=c.employee_id
      WHERE c.group_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,[id]);
    return {group,members:members.rows,changes:changes.rows,canConfigure:access.admin,canReview:access.admin};
  }
  async create(actor:Identity,body:unknown) {
    const data=object(body,['id','name','reason','contentClass']);reason(data);name(data);
    const b=data as unknown as SupportGroupInput;
    if(typeof b.id!=='string'||!groupCode.test(b.id))throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
    await this.intake.requireGeneral(actor.id,data,'support-group');
    return this.db.transaction(async client=>{
      const access=await this.access(client,actor.id,true);if(!access.admin)throw new NotFoundException();
      const inserted=await client.query('INSERT INTO support_groups(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id,name,version',[b.id,b.name.trim()]);
      if(!inserted.rowCount)throw new ConflictException({code:'GROUP_EXISTS'});
      await this.audit(client,b.id,actor.id,'CREATED',null,inserted.rows[0],b.reason.trim());
      return inserted.rows[0];
    });
  }
  async rename(actor:Identity,id:string,body:unknown) {
    const data=object(body,['name','expectedVersion','reason','contentClass']);reason(data);name(data);
    const b=data as unknown as SupportGroupUpdateInput;
    if(!Number.isInteger(b.expectedVersion)||b.expectedVersion<1)throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
    await this.intake.requireGeneral(actor.id,data,'support-group');
    return this.db.transaction(async client=>{
      const access=await this.access(client,actor.id,true);if(!access.admin)throw new NotFoundException();
      const before=await this.group(client,id,access,true);
      if(before.version!==b.expectedVersion)throw new ConflictException({code:'GROUP_VERSION_CONFLICT'});
      const after=(await client.query('UPDATE support_groups SET name=$2,version=version+1 WHERE id=$1 RETURNING id,name,version',[id,b.name.trim()])).rows[0];
      await this.audit(client,id,actor.id,'RENAMED',before,after,b.reason.trim());return after;
    });
  }
  async propose(actor:Identity,id:string,body:unknown) {
    const data=object(body,['id','employeeId','operation','expectedGroupVersion','reason','contentClass']);reason(data);
    const b=data as unknown as MembershipChangeInput;
    if(typeof b.id!=='string'||!uuid.test(b.id)||typeof b.employeeId!=='string'||!b.employeeId||b.employeeId.length>200
      ||!['ADD','REMOVE'].includes(b.operation)||!Number.isInteger(b.expectedGroupVersion)||b.expectedGroupVersion<1)
      throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
    if(b.employeeId===actor.id)throw new ForbiddenException({code:'GROUP_SELF_CHANGE_DENIED'});
    await this.intake.requireGeneral(actor.id,data,'group-membership');
    return this.db.transaction(async client=>{
      const access=await this.access(client,actor.id,true),group=await this.group(client,id,access,true);
      const existing=await client.query('SELECT * FROM group_membership_changes WHERE id=$1',[b.id]);
      if(existing.rowCount){
        const r=existing.rows[0];
        if(r.group_id!==id||r.employee_id!==b.employeeId||r.operation!==b.operation||r.group_version!==b.expectedGroupVersion
          ||r.requested_by!==actor.id||r.reason!==b.reason.trim())throw new ConflictException({code:'GROUP_CHANGE_ID_CONFLICT'});
        return this.change(client,id,b.id);
      }
      if(group.version!==b.expectedGroupVersion)throw new ConflictException({code:'GROUP_VERSION_CONFLICT'});
      const subject=await client.query('SELECT active FROM employees WHERE id=$1 FOR SHARE',[b.employeeId]);
      if(!subject.rowCount||(b.operation==='ADD'&&!subject.rows[0].active))throw new BadRequestException({code:'GROUP_SUBJECT_UNAVAILABLE'});
      const member=await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR UPDATE',[b.employeeId,id]);
      if((b.operation==='ADD')===!!member.rowCount)throw new ConflictException({code:'GROUP_MEMBERSHIP_CONFLICT'});
      const inserted=await client.query(`INSERT INTO group_membership_changes(id,group_id,employee_id,operation,group_version,requested_by,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,[b.id,id,b.employeeId,b.operation,b.expectedGroupVersion,actor.id,b.reason.trim()]);
      if(!inserted.rowCount)throw new ConflictException({code:'GROUP_CHANGE_PENDING'});
      const after=await this.change(client,id,b.id);await this.audit(client,id,actor.id,'MEMBER_PROPOSED',null,after,b.reason.trim(),b.id);return after;
    });
  }

  private async remove(client:PoolClient,group:string,employee:string,actor:string,why:string) {
    // Lock the membership before inspecting obligations; fulfillment writers also lock this row.
    if(!(await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR UPDATE',[employee,group])).rowCount)
      throw new ConflictException({code:'GROUP_MEMBERSHIP_CONFLICT'});
    const obligations=(await client.query(`SELECT
      (SELECT count(*)::int FROM tickets WHERE status NOT IN ('CLOSED','CANCELLED','REJECTED') AND
        ((owner_group_id=$1 AND assignee_id=$2) OR (pending_group_id=$1 AND pending_assignee_id=$2))) AS tickets,
      (SELECT count(*)::int FROM request_fulfillments f JOIN tickets t ON t.id=f.ticket_id
        WHERE t.owner_group_id=$1 AND f.assignee_id=$2 AND f.state<>'REVOKED' AND (f.delivered_at IS NOT NULL OR f.state='READY')) AS fulfillments,
      (SELECT count(*)::int FROM knowledge_articles WHERE owner_group_id=$1 AND author_id=$2 AND status IN ('DRAFT','IN_REVIEW','APPROVED')) AS knowledge`,[group,employee])).rows[0];
    if(obligations.tickets||obligations.fulfillments||obligations.knowledge)throw new ConflictException({code:'GROUP_RESPONSIBILITY_TRANSFER_REQUIRED',...obligations});
    const remaining=await client.query(`SELECT 1 FROM group_memberships m JOIN employees e ON e.id=m.employee_id AND e.active
      WHERE m.group_id=$1 AND m.employee_id<>$2 LIMIT 1`,[group,employee]);
    if(!remaining.rowCount)throw new ConflictException({code:'GROUP_LAST_MEMBER_REQUIRED'});
    const lead=await client.query(`SELECT 1 FROM role_bindings r WHERE r.group_id=$1 AND r.employee_id=$2 AND r.role_code='GROUP_LEAD'
      AND ${ROLE_EFFECTIVE_SQL}`,[group,employee]);
    if(lead.rowCount&&!(await client.query(`SELECT 1 FROM role_bindings r WHERE r.group_id=$1 AND r.employee_id<>$2 AND r.role_code='GROUP_LEAD'
      AND ${ROLE_EFFECTIVE_SQL}`,[group,employee])).rowCount)throw new ConflictException({code:'GROUP_LAST_LEAD_REQUIRED'});
    const specialities:string[]=[];
    for(const table of ['priority_reviewers','knowledge_reviewers','knowledge_editors']){
      const holds=await client.query(`SELECT 1 FROM ${table} WHERE group_id=$1 AND employee_id=$2`,[group,employee]);
      if(holds.rowCount)specialities.push(table);
      if(holds.rowCount&&!(await client.query(`SELECT 1 FROM ${table} p JOIN employees e ON e.id=p.employee_id AND e.active
        WHERE p.group_id=$1 AND p.employee_id<>$2`,[group,employee])).rowCount)throw new ConflictException({code:'GROUP_SPECIALIST_CONTINUITY_REQUIRED'});
    }
    const roles=await client.query("SELECT * FROM role_bindings WHERE group_id=$1 AND employee_id=$2 AND status IN ('ACTIVE','PENDING') FOR UPDATE",[group,employee]);
    for(const before of roles.rows){
      const after=(await client.query(`UPDATE role_bindings SET status='REVOKED',revoked_by=$2,revoke_reason=$3,revoked_at=now(),version=version+1
        WHERE id=$1 RETURNING *`,[before.id,actor,why])).rows[0];
      await client.query(`INSERT INTO role_binding_audits(binding_id,actor_id,action,before_value,after_value,reason)
        VALUES($1,$2,'REVOKED',$3,$4,$5)`,[before.id,actor,JSON.stringify(before),JSON.stringify(after),why]);
      await client.query("INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,'ROLE_REVOKED',$2)",[actor,before.id]);
    }
    await client.query('DELETE FROM group_memberships WHERE group_id=$1 AND employee_id=$2',[group,employee]);
    return {roles:roles.rows.map(r=>({id:r.id,roleCode:r.role_code,status:r.status})),specialities};
  }

  async review(actor:Identity,id:string,changeId:string,body:unknown) {
    if(!uuid.test(changeId))throw new NotFoundException();
    const data=object(body,['expectedVersion','decision','reason','contentClass']);reason(data);
    const b=data as unknown as MembershipReviewInput;
    if(!Number.isInteger(b.expectedVersion)||b.expectedVersion<1||!['APPROVE','REJECT'].includes(b.decision))throw new BadRequestException({code:'INVALID_GROUP_CHANGE'});
    await this.intake.requireGeneral(actor.id,data,'group-membership-review');
    return this.db.transaction(async client=>{
      const access=await this.access(client,actor.id,true);if(!access.admin)throw new NotFoundException();
      const group=await this.group(client,id,access,true);
      await client.query('SELECT id FROM group_membership_changes WHERE id=$1 AND group_id=$2 FOR UPDATE',[changeId,id]);
      const before=await this.change(client,id,changeId);
      if(before.employeeId===actor.id||before.requestedBy===actor.id)throw new ForbiddenException({code:'GROUP_INDEPENDENT_REVIEW_REQUIRED'});
      if(before.status!=='PENDING'||before.version!==b.expectedVersion)throw new ConflictException({code:'GROUP_CHANGE_VERSION_CONFLICT'});
      let removedCapabilities:object|undefined;
      if(b.decision==='APPROVE'){
        if(group.version!==before.groupVersion)throw new ConflictException({code:'GROUP_VERSION_CONFLICT'});
        const subject=await client.query('SELECT active FROM employees WHERE id=$1 FOR SHARE',[before.employeeId]);
        if(before.operation==='ADD'){
          if(!subject.rows[0]?.active)throw new BadRequestException({code:'GROUP_SUBJECT_UNAVAILABLE'});
          if((await client.query("SELECT 1 FROM role_bindings WHERE group_id=$1 AND employee_id=$2 AND status IN ('ACTIVE','PENDING')",[id,before.employeeId])).rowCount)
            throw new ConflictException({code:'GROUP_STALE_ROLE_REVIEW_REQUIRED'});
          const added=await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING employee_id',[before.employeeId,id]);
          if(!added.rowCount)throw new ConflictException({code:'GROUP_MEMBERSHIP_CONFLICT'});
        }else removedCapabilities=await this.remove(client,id,before.employeeId,actor.id,b.reason.trim());
        await client.query('UPDATE support_groups SET version=version+1 WHERE id=$1',[id]);
        await client.query('DELETE FROM auth_sessions WHERE employee_id=$1',[before.employeeId]);
      }
      await client.query(`UPDATE group_membership_changes SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1 WHERE id=$1`,
        [changeId,b.decision==='APPROVE'?'APPROVED':'REJECTED',actor.id,b.reason.trim()]);
      const after=await this.change(client,id,changeId);
      await this.audit(client,id,actor.id,b.decision==='APPROVE'?'MEMBER_APPROVED':'MEMBER_REJECTED',
        removedCapabilities?{...before,removedCapabilities}:before,after,b.reason.trim(),changeId);
      return after;
    });
  }
  async history(actor:Identity,id:string) {
    const access=await this.access(this.db.pool,actor.id);await this.group(this.db.pool,id,access);
    return {items:(await this.db.pool.query(`SELECT action,actor_id AS "actorId",change_id AS "changeId",before_value AS "beforeValue",
      after_value AS "afterValue",reason,created_at AS "createdAt" FROM support_group_audits WHERE group_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`,[id])).rows};
  }
}
