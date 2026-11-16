import { BadRequestException,ConflictException,ForbiddenException,Injectable,NotFoundException,UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SupportChangeInput,SupportChangeView } from '@itsm/contracts';
import type { Identity } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL } from './role-policy.js';
import { supportDecision,supportId,supportIndependentReview,supportProposal,supportUuid } from './support-policy.js';

type Client=Pick<PoolClient,'query'>;
type Access={admin:boolean;groups:string[]};
const columns=`p.id,p.kind,p.group_id AS "groupId",p.employee_id AS "employeeId",e.display_name AS "employeeName",
  p.config,p.expected_group_version AS "expectedGroupVersion",p.proposed_by AS "proposedBy",p.reviewed_by AS "reviewedBy",
  p.status,p.reason,p.review_reason AS "reviewReason",p.version,p.created_at AS "createdAt",p.reviewed_at AS "reviewedAt"`;
const groupColumns=`g.id,g.name,g.description,g.administration_version AS version,
  (SELECT count(*)::int FROM group_memberships m JOIN employees e ON e.id=m.employee_id WHERE m.group_id=g.id AND e.active) AS "activeMembers"`;

@Injectable()
export class SupportService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService){}

  private async access(client:Client,actor:string):Promise<Access>{
    const result=await client.query(`SELECT r.role_code,r.group_id FROM role_bindings r WHERE r.employee_id=$1
      AND r.role_code IN ('PLATFORM_ADMIN','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}`,[actor]);
    const access={admin:result.rows.some(row=>row.role_code==='PLATFORM_ADMIN'),groups:result.rows.filter(row=>row.group_id).map(row=>row.group_id as string)};
    if(!access.admin&&!access.groups.length)throw new NotFoundException();
    return access;
  }

  private async writeAccess(client:PoolClient,actor:string){
    await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
      throw new UnauthorizedException({code:'EMPLOYEE_DISABLED'});
    return this.access(client,actor);
  }

  private scope(access:Access,group:string,kind?:string){
    if(!access.admin&&(!access.groups.includes(group)||kind==='GROUP_CREATE'||kind==='GROUP_UPDATE'))throw new NotFoundException();
  }

  private async proposal(client:Client,id:string,access:Access):Promise<SupportChangeView>{
    const result=await client.query<SupportChangeView>(`SELECT ${columns} FROM support_structure_proposals p
      LEFT JOIN employees e ON e.id=p.employee_id WHERE p.id=$1 AND ($2 OR p.group_id=ANY($3::text[]))`,[id,access.admin,access.groups]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows[0];
  }

  async list(actor:Identity){
    const access=await this.access(this.db.pool,actor.id);
    const groups=await this.db.pool.query(`SELECT ${groupColumns} FROM support_groups g
      WHERE $1 OR g.id=ANY($2::text[]) ORDER BY g.name,g.id LIMIT 201`,[access.admin,access.groups]);
    const proposals=await this.db.pool.query(`SELECT ${columns} FROM support_structure_proposals p LEFT JOIN employees e ON e.id=p.employee_id
      WHERE $1 OR p.group_id=ANY($2::text[]) ORDER BY p.created_at DESC,p.id DESC LIMIT 201`,[access.admin,access.groups]);
    return {groups:groups.rows.slice(0,200),groupsHasMore:groups.rows.length>200,items:proposals.rows.slice(0,200),
      proposalsHasMore:proposals.rows.length>200,canReview:access.admin};
  }

  private search(value:unknown){
    if(value!==undefined&&(typeof value!=='string'||value.length>100))throw new BadRequestException({code:'INVALID_SUPPORT_SEARCH'});
    return ((value??'') as string).trim();
  }

  async people(actor:Identity,query:unknown){
    await this.access(this.db.pool,actor.id);
    const q=this.search(query);
    if(q.length<2)return {items:[],hasMore:false};
    const people=await this.db.pool.query(`SELECT id,display_name AS name FROM employees WHERE active AND id<>$1
      AND (position(lower($2) in lower(id))>0 OR position(lower($2) in lower(display_name))>0)
      ORDER BY display_name,id LIMIT 51`,[actor.id,q]);
    return {items:people.rows.slice(0,50),hasMore:people.rows.length>50};
  }

  async members(actor:Identity,group:string,query:unknown,pageValue:unknown){
    const access=await this.access(this.db.pool,actor.id);this.scope(access,group);
    if(!supportId(group))throw new NotFoundException();
    const page=pageValue===undefined?1:Number(pageValue);
    if(!Number.isSafeInteger(page)||page<1||page>10000)throw new BadRequestException({code:'INVALID_SUPPORT_SEARCH'});
    const q=this.search(query),g=await this.db.pool.query(`SELECT ${groupColumns} FROM support_groups g WHERE g.id=$1`,[group]);
    if(!g.rowCount)throw new NotFoundException();
    const condition=`m.group_id=$1 AND (position(lower($2) in lower(e.id))>0 OR position(lower($2) in lower(e.display_name))>0)`;
    const count=await this.db.pool.query(`SELECT count(*)::int AS total FROM group_memberships m JOIN employees e ON e.id=m.employee_id WHERE ${condition}`,[group,q]);
    const result=await this.db.pool.query(`SELECT e.id,e.display_name AS name,e.active,
      ARRAY(SELECT r.role_code FROM role_bindings r WHERE r.employee_id=e.id AND r.group_id=$1 AND ${ROLE_EFFECTIVE_SQL} ORDER BY r.role_code) AS roles,
      ARRAY(SELECT privilege FROM (
        SELECT 'P1_REVIEW' AS privilege WHERE EXISTS(SELECT 1 FROM priority_reviewers WHERE employee_id=e.id AND group_id=$1)
        UNION ALL SELECT 'KNOWLEDGE_EDIT' WHERE EXISTS(SELECT 1 FROM knowledge_editors WHERE employee_id=e.id AND group_id=$1)
        UNION ALL SELECT 'KNOWLEDGE_REVIEW' WHERE EXISTS(SELECT 1 FROM knowledge_reviewers WHERE employee_id=e.id AND group_id=$1)
        UNION ALL SELECT 'CATALOG_PUBLISH' WHERE EXISTS(SELECT 1 FROM request_catalog_publishers p JOIN service_catalog c ON c.code=p.service_code
          WHERE p.employee_id=e.id AND c.group_id=$1)) privileges) AS privileges
      FROM group_memberships m JOIN employees e ON e.id=m.employee_id WHERE ${condition}
      ORDER BY e.display_name,e.id LIMIT 50 OFFSET $3`,[group,q,(page-1)*50]);
    return {group:g.rows[0],items:result.rows,total:count.rows[0].total,page,size:50};
  }

  private async audit(client:PoolClient,id:string,actor:string,action:string,before:object|null,after:object,reason:string){
    await client.query(`INSERT INTO support_structure_audits(proposal_id,actor_id,action,before_value,after_value,reason)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,actor,action,before===null?null:JSON.stringify(before),JSON.stringify(after),reason]);
    await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,`SUPPORT_${action}`,id]);
  }

  private async expected(client:PoolClient,input:Pick<SupportChangeInput,'kind'|'groupId'|'expectedGroupVersion'>){
    const group=await client.query('SELECT * FROM support_groups WHERE id=$1 FOR UPDATE',[input.groupId]);
    if(input.kind==='GROUP_CREATE'){
      if(group.rowCount)throw new ConflictException({code:'SUPPORT_GROUP_EXISTS'});
    }else if(!group.rowCount||group.rows[0].administration_version!==input.expectedGroupVersion)
      throw new ConflictException({code:'SUPPORT_VERSION_CONFLICT'});
    return group.rows[0];
  }

  async propose(actor:Identity,body:unknown){
    const input=supportProposal(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'support-structure');
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return this.db.transaction(async client=>{
      const access=await this.writeAccess(client,actor.id);this.scope(access,input.groupId,input.kind);
      const prior=await client.query('SELECT proposed_by,request_hash FROM support_structure_proposals WHERE id=$1',[input.id]);
      if(prior.rowCount){
        if(prior.rows[0].proposed_by!==actor.id||prior.rows[0].request_hash!==hash)throw new ConflictException({code:'SUPPORT_ID_CONFLICT'});
        return this.proposal(client,input.id,access);
      }
      if(input.kind==='MEMBER_ADD'&&input.employeeId===actor.id)throw new ForbiddenException({code:'SUPPORT_SELF_GRANT_DENIED'});
      await this.expected(client,input);
      if(input.employeeId){
        if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND ($2 OR active) FOR SHARE',[input.employeeId,input.kind==='MEMBER_REMOVE'])).rowCount)
          throw new BadRequestException({code:'SUPPORT_PERSON_UNAVAILABLE'});
        const membership=await client.query('SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[input.employeeId,input.groupId]);
        if((input.kind==='MEMBER_ADD')===!!membership.rowCount)throw new ConflictException({code:'SUPPORT_MEMBERSHIP_CONFLICT'});
      }
      const result=await client.query(`INSERT INTO support_structure_proposals(id,kind,group_id,employee_id,config,expected_group_version,request_hash,proposed_by,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
        [input.id,input.kind,input.groupId,input.employeeId??null,JSON.stringify(input.config),input.expectedGroupVersion,hash,actor.id,input.reason]);
      if(!result.rowCount)throw new ConflictException({code:'SUPPORT_CHANGE_PENDING'});
      const proposal=await this.proposal(client,input.id,access);
      await this.audit(client,input.id,actor.id,'PROPOSED',null,proposal,input.reason);
      return proposal;
    });
  }

  private async removeMember(client:PoolClient,p:SupportChangeView,reviewer:string,reason:string){
    const group=p.groupId,employee=p.employeeId!;
    // Membership is locked before inspecting duties: in-flight work must finish or revalidate membership.
    if(!(await client.query('SELECT 1 FROM group_memberships WHERE group_id=$1 AND employee_id=$2 FOR UPDATE',[group,employee])).rowCount)
      throw new ConflictException({code:'SUPPORT_MEMBERSHIP_CONFLICT'});
    const duty=await client.query(`SELECT
      EXISTS(SELECT 1 FROM tickets WHERE status NOT IN ('CLOSED','CANCELLED','REJECTED') AND
        ((owner_group_id=$1 AND assignee_id=$2) OR (pending_group_id=$1 AND pending_assignee_id=$2))) AS tickets,
      EXISTS(SELECT 1 FROM request_fulfillments f JOIN tickets t ON t.id=f.ticket_id WHERE t.owner_group_id=$1 AND f.assignee_id=$2
        AND (f.state IN ('READY','DELIVERED','REVOKE_DUE') OR (f.delivered_at IS NOT NULL AND f.revoked_at IS NULL))) AS fulfillments,
      EXISTS(SELECT 1 FROM knowledge_articles WHERE owner_group_id=$1 AND author_id=$2 AND status IN ('DRAFT','IN_REVIEW','APPROVED')) AS knowledge`,[group,employee]);
    if(duty.rows[0].tickets||duty.rows[0].fulfillments||duty.rows[0].knowledge)
      throw new ConflictException({code:'SUPPORT_OPEN_RESPONSIBILITIES'});
    const remaining=await client.query(`SELECT e.id FROM group_memberships m JOIN employees e ON e.id=m.employee_id
      WHERE m.group_id=$1 AND m.employee_id<>$2 AND e.active ORDER BY e.id FOR SHARE OF m,e`,[group,employee]);
    if(!remaining.rowCount)throw new ConflictException({code:'SUPPORT_MEMBER_CONTINUITY_REQUIRED'});
    const lead=await client.query(`SELECT r.employee_id FROM role_bindings r WHERE r.group_id=$1 AND r.role_code='GROUP_LEAD' AND ${ROLE_EFFECTIVE_SQL}`,[group]);
    if(lead.rows.some(row=>row.employee_id===employee)&&!lead.rows.some(row=>row.employee_id!==employee))
      throw new ConflictException({code:'SUPPORT_LEAD_CONTINUITY_REQUIRED'});
    const p1=await client.query(`SELECT 1 FROM priority_reviewers WHERE employee_id=$1 AND group_id=$2`,[employee,group]);
    if(p1.rowCount&&!(await client.query(`SELECT 1 FROM priority_reviewers p JOIN employees e ON e.id=p.employee_id
      WHERE p.group_id=$1 AND p.employee_id<>$2 AND e.active`,[group,employee])).rowCount)
      throw new ConflictException({code:'SUPPORT_REVIEW_CONTINUITY_REQUIRED'});
    const before={employeeId:employee,groupId:group,roles:(await client.query(`SELECT * FROM role_bindings WHERE employee_id=$1 AND group_id=$2 AND status IN ('PENDING','ACTIVE')`,[employee,group])).rows,
      priorityReviewer:!!p1.rowCount,knowledgeEditor:!!(await client.query('SELECT 1 FROM knowledge_editors WHERE employee_id=$1 AND group_id=$2',[employee,group])).rowCount,
      knowledgeReviewer:!!(await client.query('SELECT 1 FROM knowledge_reviewers WHERE employee_id=$1 AND group_id=$2',[employee,group])).rowCount,
      catalogServices:(await client.query(`SELECT p.service_code FROM request_catalog_publishers p JOIN service_catalog c ON c.code=p.service_code
        WHERE p.employee_id=$1 AND c.group_id=$2 ORDER BY p.service_code`,[employee,group])).rows.map(row=>row.service_code)};
    for(const binding of before.roles){
      const changed=(await client.query(`UPDATE role_bindings SET status='REVOKED',revoked_by=$2,revoke_reason=$3,revoked_at=now(),version=version+1
        WHERE id=$1 RETURNING *`,[binding.id,reviewer,reason])).rows[0];
      await client.query(`INSERT INTO role_binding_audits(binding_id,actor_id,action,before_value,after_value,reason)
        VALUES($1,$2,'REVOKED',$3,$4,$5)`,[binding.id,reviewer,JSON.stringify(binding),JSON.stringify(changed),reason]);
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[reviewer,'ROLE_REVOKED',binding.id]);
    }
    await client.query(`DELETE FROM request_catalog_publishers p USING service_catalog c WHERE p.service_code=c.code AND p.employee_id=$1 AND c.group_id=$2`,[employee,group]);
    if((await client.query(`SELECT 1 FROM position_appointments a JOIN support_positions p ON p.id=a."positionId"
      WHERE a."employeeId"=$1 AND p."groupId"=$2 AND a.enabled AND a."validTo">clock_timestamp() LIMIT 1`,[employee,group])).rowCount)
      throw new ConflictException({code:'SUPPORT_POSITION_APPOINTMENT_ACTIVE'});
    await client.query('DELETE FROM priority_reviewers WHERE employee_id=$1 AND group_id=$2',[employee,group]);
    await client.query('DELETE FROM knowledge_editors WHERE employee_id=$1 AND group_id=$2',[employee,group]);
    await client.query('DELETE FROM knowledge_reviewers WHERE employee_id=$1 AND group_id=$2',[employee,group]);
    await client.query('DELETE FROM group_memberships WHERE employee_id=$1 AND group_id=$2',[employee,group]);
    return before;
  }

  async review(actor:Identity,id:string,body:unknown){
    if(!supportUuid.test(id))throw new NotFoundException();
    const input=supportDecision(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'support-structure');
    return this.db.transaction(async client=>{
      const access=await this.writeAccess(client,actor.id);if(!access.admin)throw new NotFoundException();
      await client.query('SELECT id FROM support_structure_proposals WHERE id=$1 FOR UPDATE',[id]);
      const p=await this.proposal(client,id,access);
      if(!supportIndependentReview(actor.id,p.proposedBy,p.employeeId))throw new ForbiddenException({code:'SUPPORT_INDEPENDENT_REVIEW_REQUIRED'});
      if(p.status!=='PENDING'){
        if(p.version===input.expectedVersion+1&&p.reviewedBy===actor.id&&p.status===(input.decision==='APPROVE'?'APPROVED':'REJECTED')&&p.reviewReason===input.reason)return p;
        throw new ConflictException({code:'SUPPORT_VERSION_CONFLICT'});
      }
      if(p.version!==input.expectedVersion)throw new ConflictException({code:'SUPPORT_VERSION_CONFLICT'});
      let before:object|null=null,after:object=p;
      if(input.decision==='APPROVE'){
        let proposer:Access;
        try{proposer=await this.access(client,p.proposedBy);}catch(error){if(error instanceof NotFoundException)throw new ConflictException({code:'SUPPORT_PROPOSER_UNAVAILABLE'});throw error;}
        if(!proposer.admin&&(!proposer.groups.includes(p.groupId)||!['MEMBER_ADD','MEMBER_REMOVE'].includes(p.kind)))
          throw new ConflictException({code:'SUPPORT_PROPOSER_UNAVAILABLE'});
        const group=await this.expected(client,{kind:p.kind,groupId:p.groupId,expectedGroupVersion:p.expectedGroupVersion});
        before=group??null;
        if(p.kind==='GROUP_CREATE'||p.kind==='GROUP_UPDATE'){
          const config=p.config as {name:string;description:string};
          if(p.kind==='GROUP_CREATE'){
            if(!(await client.query(`INSERT INTO support_groups(id,name,description) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,[p.groupId,config.name,config.description])).rowCount)
              throw new ConflictException({code:'SUPPORT_GROUP_EXISTS'});
          }else await client.query('UPDATE support_groups SET name=$2,description=$3,administration_version=administration_version+1 WHERE id=$1',[p.groupId,config.name,config.description]);
        }else{
          if(p.kind==='MEMBER_ADD'){
            if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[p.employeeId])).rowCount)
              throw new ConflictException({code:'SUPPORT_PERSON_UNAVAILABLE'});
            if(!(await client.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING employee_id',[p.employeeId,p.groupId])).rowCount)
              throw new ConflictException({code:'SUPPORT_MEMBERSHIP_CONFLICT'});
          }else before={group,removed:await this.removeMember(client,p,actor.id,input.reason)};
          await client.query('UPDATE support_groups SET administration_version=administration_version+1 WHERE id=$1',[p.groupId]);
        }
        after={group:(await client.query(`SELECT ${groupColumns} FROM support_groups g WHERE g.id=$1`,[p.groupId])).rows[0],
          employeeId:p.employeeId,membership:p.kind==='MEMBER_ADD'?true:p.kind==='MEMBER_REMOVE'?false:null};
      }
      await client.query(`UPDATE support_structure_proposals SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1 WHERE id=$1`,
        [id,input.decision==='APPROVE'?'APPROVED':'REJECTED',actor.id,input.reason]);
      const result=await this.proposal(client,id,access);
      await this.audit(client,id,actor.id,input.decision==='APPROVE'?'APPROVED':'REJECTED',before,after,input.reason);
      return result;
    });
  }

  async history(actor:Identity,id:string){
    if(!supportUuid.test(id))throw new NotFoundException();
    const access=await this.access(this.db.pool,actor.id);await this.proposal(this.db.pool,id,access);
    return {items:(await this.db.pool.query(`SELECT actor_id AS "actorId",action,before_value AS "beforeValue",after_value AS "afterValue",reason,created_at AS "createdAt"
      FROM support_structure_audits WHERE proposal_id=$1 ORDER BY created_at,id`,[id])).rows};
  }
}
