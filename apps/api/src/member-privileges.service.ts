import {ConflictException,Injectable,NotFoundException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {validEmployeeId,type MemberPrivilegeState,type MemberPrivilegesView,type MemberPrivilegesReceipt} from '@itsm/contracts';
import type {Identity} from './auth.service.js';
import {Database} from './database.service.js';
import {IntakePolicyService} from './intake-policy.service.js';
import {ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL} from './role-policy.js';
import {memberPrivilegesInput,supportId} from './support-policy.js';

const grants={P1_REVIEW:'priority_reviewers',KNOWLEDGE_EDIT:'knowledge_editors',KNOWLEDGE_REVIEW:'knowledge_reviewers'} as const;
@Injectable()
export class MemberPrivilegesService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService){}

  private async authorize(c:PoolClient,actor:string,write=false){
    await c.query(`SELECT ${write?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}($1)`,[ROLE_AUTHORIZATION_LOCK]);
    if(!(await c.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND ${ROLE_EFFECTIVE_SQL} LIMIT 1`,[actor])).rowCount)throw new NotFoundException();
  }
  private async view(c:PoolClient,group:string,employee:string):Promise<MemberPrivilegesView>{
    const g=(await c.query(`SELECT g.id,g.name,g.description,g.enabled,g.administration_version AS version,
      (SELECT count(*)::int FROM group_memberships m JOIN employees e ON e.id=m.employee_id WHERE m.group_id=g.id AND e.active) AS "activeMembers"
      FROM support_groups g WHERE g.id=$1`,[group])).rows[0];
    const member=(await c.query(`SELECT e.id,e.display_name AS name,e.active FROM group_memberships m JOIN employees e ON e.id=m.employee_id
      WHERE m.group_id=$1 AND m.employee_id=$2`,[group,employee])).rows[0];
    if(!g||!member)throw new NotFoundException();
    const privileges:MemberPrivilegeState['privileges']=[];
    for(const [code,table] of Object.entries(grants))if((await c.query(`SELECT 1 FROM ${table} WHERE group_id=$1 AND employee_id=$2`,[group,employee])).rowCount)
      privileges.push(code as MemberPrivilegeState['privileges'][number]);
    const catalogServices=(await c.query(`SELECT code,name,published FROM service_catalog WHERE group_id=$1 AND type='REQ' ORDER BY name,code`,[group])).rows;
    const catalogServiceCodes=(await c.query(`SELECT p.service_code FROM request_catalog_publishers p JOIN service_catalog s ON s.code=p.service_code
      WHERE p.employee_id=$1 AND s.group_id=$2 ORDER BY p.service_code`,[employee,group])).rows.map(r=>r.service_code as string);
    return {group:g,member,privileges:privileges.sort(),catalogServiceCodes,catalogServices};
  }
  async get(actor:Identity,group:string,employee:string){
    if(!supportId(group)||!validEmployeeId(employee))throw new NotFoundException();
    return this.db.transaction(async c=>{
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await this.authorize(c,actor.id);return this.view(c,group,employee);
    });
  }
  private async continuity(c:PoolClient,group:string,employee:string,before:MemberPrivilegeState,after:MemberPrivilegeState){
    const removing=(code:MemberPrivilegeState['privileges'][number])=>before.privileges.includes(code)&&!after.privileges.includes(code);
    if(removing('P1_REVIEW')){
      if(!(await c.query(`SELECT 1 FROM priority_reviewers p JOIN employees e ON e.id=p.employee_id
        WHERE p.group_id=$1 AND p.employee_id<>$2 AND e.active`,[group,employee])).rowCount)
        throw new ConflictException({code:'SUPPORT_REVIEW_CONTINUITY_REQUIRED'});
      const stranded=await c.query(`SELECT 1 FROM tickets t WHERE t.owner_group_id=$1 AND t.priority_review_state='PENDING'
        AND t.status NOT IN ('CLOSED','CANCELLED','REJECTED') AND NOT EXISTS(
          SELECT 1 FROM priority_reviewers p JOIN employees e ON e.id=p.employee_id
          WHERE p.group_id=$1 AND p.employee_id<>$2 AND e.active AND p.employee_id<>t.requester_id
          AND p.employee_id<>t.submitted_by_id AND p.employee_id IS DISTINCT FROM t.priority_changed_by) LIMIT 1`,[group,employee]);
      if(stranded.rowCount)throw new ConflictException({code:'MEMBER_PRIVILEGE_PENDING_P1'});
    }
    if(removing('KNOWLEDGE_EDIT')){
      const stranded=await c.query(`SELECT 1 FROM knowledge_articles a WHERE a.owner_group_id=$1 AND
        ((a.author_id=$2 AND a.status IN ('DRAFT','IN_REVIEW','APPROVED')) OR (a.status='APPROVED' AND NOT EXISTS(
          SELECT 1 FROM knowledge_editors k JOIN employees e ON e.id=k.employee_id
          WHERE k.group_id=$1 AND k.employee_id<>$2 AND e.active AND k.employee_id IS DISTINCT FROM a.reviewed_by))) LIMIT 1`,[group,employee]);
      if(stranded.rowCount)throw new ConflictException({code:'MEMBER_PRIVILEGE_PENDING_KNOWLEDGE'});
    }
    if(removing('KNOWLEDGE_REVIEW')&&(await c.query(`SELECT 1 FROM knowledge_articles a WHERE a.owner_group_id=$1 AND a.status='IN_REVIEW'
      AND NOT EXISTS(SELECT 1 FROM knowledge_reviewers k JOIN employees e ON e.id=k.employee_id
        WHERE k.group_id=$1 AND k.employee_id<>$2 AND e.active AND k.employee_id<>a.author_id) LIMIT 1`,[group,employee])).rowCount)
      throw new ConflictException({code:'MEMBER_PRIVILEGE_PENDING_KNOWLEDGE'});
  }
  async save(actor:Identity,group:string,employee:string,body:unknown):Promise<MemberPrivilegesReceipt>{
    if(!supportId(group)||!validEmployeeId(employee))throw new NotFoundException();
    const input=memberPrivilegesInput(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'support-structure');
    const hash=createHash('sha256').update(JSON.stringify({group,employee,input})).digest('hex');
    return this.db.transaction(async c=>{
      await this.authorize(c,actor.id,true);
      const replay=(await c.query('SELECT actor_id,request_hash,response FROM member_privilege_audits WHERE id=$1',[input.id])).rows[0];
      if(replay){
        if(replay.actor_id!==actor.id||replay.request_hash!==hash)throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});
        return replay.response;
      }
      await c.query('SELECT id FROM support_groups WHERE id=$1 FOR UPDATE',[group]);
      await c.query('SELECT employee_id FROM group_memberships WHERE group_id=$1 AND employee_id=$2 FOR UPDATE',[group,employee]);
      await c.query('SELECT id FROM employees WHERE id=$1 FOR SHARE',[employee]);
      const current=await this.view(c,group,employee);
      if(!current.group.enabled||!current.member.active)throw new ConflictException({code:'SUPPORT_PERSON_UNAVAILABLE'});
      if(current.group.version!==input.expectedGroupVersion)throw new ConflictException({code:'SUPPORT_VERSION_CONFLICT'});
      // Lock exact service ownership while validating scoped publisher grants.
      const services=await c.query(`SELECT code,type,group_id FROM service_catalog WHERE code=ANY($1::text[]) ORDER BY code FOR SHARE`,[input.catalogServiceCodes]);
      if(services.rowCount!==input.catalogServiceCodes.length||services.rows.some(r=>r.type!=='REQ'||r.group_id!==group))
        throw new ConflictException({code:'MEMBER_PRIVILEGE_CATALOG_SCOPE'});
      const before={employeeId:employee,groupId:group,privileges:current.privileges,catalogServiceCodes:current.catalogServiceCodes,version:current.group.version};
      await this.continuity(c,group,employee,before,input);
      for(const [code,table] of Object.entries(grants)){
        if(input.privileges.includes(code as MemberPrivilegeState['privileges'][number]))
          await c.query(`INSERT INTO ${table}(employee_id,group_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[employee,group]);
        else await c.query(`DELETE FROM ${table} WHERE employee_id=$1 AND group_id=$2`,[employee,group]);
      }
      await c.query(`DELETE FROM request_catalog_publishers p USING service_catalog s WHERE p.service_code=s.code
        AND p.employee_id=$1 AND s.group_id=$2 AND NOT(p.service_code=ANY($3::text[]))`,[employee,group,input.catalogServiceCodes]);
      for(const code of input.catalogServiceCodes)await c.query(`INSERT INTO request_catalog_publishers(employee_id,service_code) VALUES($1,$2) ON CONFLICT DO NOTHING`,[employee,code]);
      const version=(await c.query(`UPDATE support_groups SET administration_version=administration_version+1 WHERE id=$1 RETURNING administration_version`,[group])).rows[0].administration_version;
      const response:MemberPrivilegesReceipt={id:input.id,groupId:group,employeeId:employee,version,privileges:input.privileges,catalogServiceCodes:input.catalogServiceCodes};
      await c.query(`INSERT INTO member_privilege_audits(id,actor_id,group_id,employee_id,request_hash,before_value,after_value,response,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[input.id,actor.id,group,employee,hash,JSON.stringify(before),JSON.stringify(response),JSON.stringify(response),input.reason]);
      return response;
    });
  }
}
