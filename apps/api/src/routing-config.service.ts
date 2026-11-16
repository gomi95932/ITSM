import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient, QueryResult } from 'pg';
import { type ServiceCalendar } from '@itsm/contracts';
import { Database } from './database.service.js';
import type { Identity } from './auth.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK, ROLE_EFFECTIVE_SQL } from './role-policy.js';

type PolicyConfig={enabled:boolean;receiveMinutes?:number;calendar?:ServiceCalendar;validFrom?:string;validTo?:string};
type FallbackConfig={fallbackGroupId:string|null};
type Proposal={id:string;kind:'ASSIGNMENT_POLICY'|'FALLBACK';groupId:string;priority:string|null;
  config:PolicyConfig|FallbackConfig;expectedPolicyId:string|null;expectedRoutingVersion:number|null;
  status:'PENDING'|'APPROVED'|'REJECTED';proposedBy:string;reviewedBy:string|null;reason:string;
  reviewReason:string|null;version:number;createdAt:Date;reviewedAt:Date|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const only=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(key=>keys.includes(key));
const name=(v:unknown):v is string=>typeof v==='string'&&v.length<=100&&/^[a-zA-Z0-9_-]+$/.test(v);
const reason=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=500;
const day=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
  && Number.isFinite(Date.parse(v));
function calendar(value:unknown):value is ServiceCalendar {
  if(!object(value)||!only(value,['timeZone','startHour','endHour','holidays','workdays'])
    || value.timeZone!=='Asia/Shanghai'||!Number.isInteger(value.startHour)||!Number.isInteger(value.endHour)
    || (value.startHour as number)<0||(value.endHour as number)>24||(value.startHour as number)>=(value.endHour as number))return false;
  const dates=(v:unknown)=>Array.isArray(v)&&v.length<=366&&v.every(day)&&new Set(v).size===v.length;
  return dates(value.holidays)&&dates(value.workdays)
    && !(value.holidays as string[]).some(d=>(value.workdays as string[]).includes(d));
}
function validateProposal(body:unknown) {
  if(!object(body)||!only(body,['id','kind','groupId','priority','config','expectedPolicyId','expectedRoutingVersion','reason','contentClass'])
    ||body.contentClass!=='GENERAL'||!uuid.test(String(body.id))||!name(body.groupId)||!reason(body.reason)
    ||!object(body.config))throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
  if(body.kind==='ASSIGNMENT_POLICY'){
    if(!['P1','P2','P3','P4'].includes(String(body.priority))
      ||(body.expectedPolicyId!==null&&!uuid.test(String(body.expectedPolicyId)))||body.expectedRoutingVersion!==undefined
      ||!only(body.config,['enabled','receiveMinutes','calendar','validFrom','validTo'])
      ||typeof body.config.enabled!=='boolean')throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
    if(body.config.enabled){
      if(!Number.isInteger(body.config.receiveMinutes)||(body.config.receiveMinutes as number)<1||(body.config.receiveMinutes as number)>10080
        ||!calendar(body.config.calendar)||!timestamp(body.config.validFrom)||!timestamp(body.config.validTo))
        throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
    }else if(Object.keys(body.config).length!==1)throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
  }else if(body.kind==='FALLBACK'){
    if(body.priority!==undefined||body.expectedPolicyId!==undefined
      ||!Number.isInteger(body.expectedRoutingVersion)||(body.expectedRoutingVersion as number)<1
      ||!only(body.config,['fallbackGroupId'])||!Object.hasOwn(body.config,'fallbackGroupId')
      ||(body.config.fallbackGroupId!==null&&!name(body.config.fallbackGroupId)))
      throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
  }else throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
  return body as {id:string;kind:Proposal['kind'];groupId:string;priority?:string;config:PolicyConfig|FallbackConfig;
    expectedPolicyId?:string|null;expectedRoutingVersion?:number;reason:string;contentClass:'GENERAL'};
}
function validateDecision(body:unknown){
  if(!object(body)||!only(body,['expectedVersion','decision','reason','contentClass'])||body.contentClass!=='GENERAL'
    ||!Number.isInteger(body.expectedVersion)||(body.expectedVersion as number)<1
    ||!['APPROVE','REJECT'].includes(String(body.decision))||!reason(body.reason))
    throw new BadRequestException({code:'INVALID_ROUTING_CONFIG'});
  return body as {expectedVersion:number;decision:'APPROVE'|'REJECT';reason:string;contentClass:'GENERAL'};
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(object(value))return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}
const columns=`id,kind,group_id AS "groupId",priority,config,expected_policy_id AS "expectedPolicyId",
  expected_routing_version AS "expectedRoutingVersion",status,proposed_by AS "proposedBy",
  reviewed_by AS "reviewedBy",reason,review_reason AS "reviewReason",version,created_at AS "createdAt",reviewed_at AS "reviewedAt"`;

@Injectable()
export class RoutingConfigService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService) {}

  private async admin(client:Pick<PoolClient,'query'>,actor:string){
    const role=await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND ${ROLE_EFFECTIVE_SQL} LIMIT 1`,[actor]);
    if(!role.rowCount)throw new NotFoundException();
  }

  private async writeAdmin(client:PoolClient,actor:string){
    await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await client.query('SELECT 1 FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
      throw new UnauthorizedException({code:'EMPLOYEE_DISABLED'});
    await this.admin(client,actor);
    await client.query('SELECT pg_advisory_xact_lock($1)',[84372911]);
  }

  private async currentPolicy(client:Pick<PoolClient,'query'>,groupId:string,priority:string){
    const row=await client.query('SELECT id FROM assignment_policy_versions WHERE group_id=$1 AND priority=$2 AND active',[groupId,priority]);
    return (row.rows[0]?.id??null) as string|null;
  }

  private async audit(client:PoolClient,proposal:Proposal,actor:string,action:'PROPOSED'|'APPROVED'|'REJECTED',before:unknown,after:unknown,why:string){
    await client.query(`INSERT INTO routing_config_audits(proposal_id,actor_id,action,before_value,after_value,reason)
      VALUES($1,$2,$3,$4,$5,$6)`,[proposal.id,actor,action,before===null?null:JSON.stringify(before),JSON.stringify(after),why]);
    await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,`ROUTING_${action}`,proposal.id]);
  }

  async list(actor:Identity){
    await this.admin(this.db.pool,actor.id);
    const [groups,policies,proposals]=await Promise.all([
      this.db.pool.query('SELECT id,name,fallback_group_id AS "fallbackGroupId",routing_version AS "routingVersion" FROM support_groups ORDER BY name,id'),
      this.db.pool.query(`SELECT id,group_id AS "groupId",priority,receive_minutes AS "receiveMinutes",calendar_snapshot AS calendar,
        valid_from AS "validFrom",valid_to AS "validTo",approved_by AS "approvedBy"
        FROM assignment_policy_versions WHERE active ORDER BY group_id,priority`),
      this.db.pool.query<Proposal>(`SELECT ${columns} FROM routing_config_proposals ORDER BY created_at DESC,id DESC LIMIT 200`),
    ]);
    return {groups:groups.rows,policies:policies.rows,proposals:proposals.rows};
  }

  async history(actor:Identity,id:string){
    if(!uuid.test(id))throw new NotFoundException();
    await this.admin(this.db.pool,actor.id);
    if(!(await this.db.pool.query('SELECT 1 FROM routing_config_proposals WHERE id=$1',[id])).rowCount)throw new NotFoundException();
    return {items:(await this.db.pool.query(`SELECT actor_id AS "actorId",action,before_value AS "beforeValue",
      after_value AS "afterValue",reason,created_at AS "createdAt" FROM routing_config_audits
      WHERE proposal_id=$1 ORDER BY created_at,id`,[id])).rows};
  }

  async propose(actor:Identity,body:unknown){
    const input=validateProposal(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'routing-config');
    return this.db.transaction(async client=>{
      await this.writeAdmin(client,actor.id);
      const existing=await client.query<Proposal>(`SELECT ${columns} FROM routing_config_proposals WHERE id=$1`,[input.id]);
      if(existing.rowCount){
        const p=existing.rows[0];
        if(p.proposedBy!==actor.id||p.kind!==input.kind||p.groupId!==input.groupId||p.priority!==(input.priority??null)
          ||p.expectedPolicyId!==(input.expectedPolicyId??null)||p.expectedRoutingVersion!==(input.expectedRoutingVersion??null)
          ||canonical(p.config)!==canonical(input.config)||p.reason!==input.reason.trim())
          throw new ConflictException({code:'ROUTING_ID_CONFLICT'});
        return p;
      }
      const group=await client.query('SELECT id,routing_version FROM support_groups WHERE id=$1 FOR UPDATE',[input.groupId]);
      if(!group.rowCount)throw new BadRequestException({code:'ROUTING_GROUP_UNAVAILABLE'});
      const before=input.kind==='FALLBACK'
        ?group.rows[0].routing_version as number
        :await this.currentPolicy(client,input.groupId,input.priority!);
      if(before!==(input.kind==='FALLBACK'?input.expectedRoutingVersion:input.expectedPolicyId))
        throw new ConflictException({code:'ROUTING_VERSION_CONFLICT'});
      if(input.kind==='ASSIGNMENT_POLICY'&&(input.config as PolicyConfig).enabled){
        const config=input.config as PolicyConfig,from=Date.parse(config.validFrom!),to=Date.parse(config.validTo!);
        if(from<Date.now()-300000||from>Date.now()+366*86400000||to<=Date.now()||to<=from||to>Date.now()+366*86400000)
          throw new BadRequestException({code:'ROUTING_VALIDITY_INVALID'});
      }
      const inserted=await client.query<Proposal>(`INSERT INTO routing_config_proposals
        (id,kind,group_id,priority,config,expected_policy_id,expected_routing_version,proposed_by,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,
      [input.id,input.kind,input.groupId,input.priority??null,JSON.stringify(input.config),input.expectedPolicyId??null,
        input.expectedRoutingVersion??null,actor.id,input.reason.trim()]);
      const proposal=inserted.rows[0];
      await this.audit(client,proposal,actor.id,'PROPOSED',null,proposal,input.reason.trim());
      return proposal;
    });
  }

  async review(actor:Identity,id:string,body:unknown){
    if(!uuid.test(id))throw new NotFoundException();
    const input=validateDecision(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'routing-config');
    return this.db.transaction(async client=>{
      await this.writeAdmin(client,actor.id);
      const found=await client.query<Proposal>(`SELECT ${columns} FROM routing_config_proposals WHERE id=$1 FOR UPDATE`,[id]);
      if(!found.rowCount)throw new NotFoundException();
      const proposal=found.rows[0];
      if(proposal.version!==input.expectedVersion||proposal.status!=='PENDING')
        throw new ConflictException({code:'ROUTING_VERSION_CONFLICT'});
      if(proposal.proposedBy===actor.id)throw new ForbiddenException({code:'ROUTING_INDEPENDENT_REVIEW_REQUIRED'});
      const group=await client.query('SELECT * FROM support_groups WHERE id=$1 FOR UPDATE',[proposal.groupId]);
      if(!group.rowCount)throw new ConflictException({code:'ROUTING_GROUP_UNAVAILABLE'});
      const before=proposal.kind==='FALLBACK'
        ?{fallbackGroupId:group.rows[0].fallback_group_id,routingVersion:group.rows[0].routing_version}
        :{policyId:await this.currentPolicy(client,proposal.groupId,proposal.priority!)};
      if(input.decision==='APPROVE'){
        if(proposal.kind==='FALLBACK'){
          if(group.rows[0].routing_version!==proposal.expectedRoutingVersion)throw new ConflictException({code:'ROUTING_VERSION_CONFLICT'});
          const target=(proposal.config as FallbackConfig).fallbackGroupId;
          if(target){
            const visited=new Set([proposal.groupId]);let cursor:string|null=target;
            while(cursor){
              if(visited.has(cursor))throw new BadRequestException({code:'ROUTING_FALLBACK_CYCLE'});
              visited.add(cursor);
              const next:QueryResult<{fallback_group_id:string|null}>=await client.query('SELECT fallback_group_id FROM support_groups WHERE id=$1',[cursor]);
              if(!next.rowCount)throw new BadRequestException({code:'ROUTING_GROUP_UNAVAILABLE'});
              cursor=next.rows[0].fallback_group_id;
            }
          }
          await client.query('UPDATE support_groups SET fallback_group_id=$2,routing_version=routing_version+1 WHERE id=$1',[proposal.groupId,target]);
        }else{
          if(before.policyId!==proposal.expectedPolicyId)throw new ConflictException({code:'ROUTING_VERSION_CONFLICT'});
          const config=proposal.config as PolicyConfig;
          if(config.enabled){
            const from=Date.parse(config.validFrom!),to=Date.parse(config.validTo!);
            if(to<=Date.now()||to<=from)throw new ConflictException({code:'ROUTING_VALIDITY_INVALID'});
          }
          await client.query('UPDATE assignment_policy_versions SET active=false WHERE group_id=$1 AND priority=$2 AND active',
            [proposal.groupId,proposal.priority]);
          if(config.enabled)await client.query(`INSERT INTO assignment_policy_versions
            (group_id,priority,receive_minutes,calendar_snapshot,valid_from,valid_to,proposed_by,approved_by,approved_at,active)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),true)`,[proposal.groupId,proposal.priority,config.receiveMinutes,
            JSON.stringify(config.calendar),config.validFrom,config.validTo,proposal.proposedBy,actor.id]);
        }
      }
      const updated=await client.query<Proposal>(`UPDATE routing_config_proposals SET status=$2,reviewed_by=$3,review_reason=$4,
        reviewed_at=now(),version=version+1 WHERE id=$1 RETURNING ${columns}`,
        [id,input.decision==='APPROVE'?'APPROVED':'REJECTED',actor.id,input.reason.trim()]);
      const after=input.decision==='APPROVE'?(proposal.kind==='FALLBACK'
        ?{fallbackGroupId:(proposal.config as FallbackConfig).fallbackGroupId,routingVersion:group.rows[0].routing_version+1}
        :{policyId:await this.currentPolicy(client,proposal.groupId,proposal.priority!)}):before;
      await this.audit(client,updated.rows[0],actor.id,input.decision==='APPROVE'?'APPROVED':'REJECTED',before,after,input.reason.trim());
      return updated.rows[0];
    });
  }
}
