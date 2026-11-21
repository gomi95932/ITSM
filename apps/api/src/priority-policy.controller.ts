import {BadRequestException,Body,ConflictException,Controller,ForbiddenException,Get,Headers,NotFoundException,Param,Post} from '@nestjs/common';
import {validPriorityPolicy} from '@itsm/contracts';
import type {PoolClient} from 'pg';
import {AuthService} from './auth.service.js';
import {Database} from './database.service.js';
import {IntakePolicyService} from './intake-policy.service.js';
import {ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL} from './role-policy.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const reason=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=500;
@Controller('admin/priority-policy')
export class PriorityPolicyController {
  constructor(private readonly db:Database,private readonly identity:AuthService,private readonly intake:IntakePolicyService){}
  private async lock(client:PoolClient,actor:string){
    await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await client.query('SELECT 1 FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
      throw new ForbiddenException({code:'PLATFORM_ADMIN_REQUIRED'});
    if(!(await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND r.group_id IS NULL AND ${ROLE_EFFECTIVE_SQL}`,[actor])).rowCount)throw new ForbiddenException({code:'PLATFORM_ADMIN_REQUIRED'});
    await client.query('SELECT pg_advisory_xact_lock(84372912)');
  }
  @Get() async list(@Headers() h:H){
    const actor=await this.identity.identity(auth(h));
    return this.db.transaction(async client=>{
      await this.lock(client,actor.id);
      const current=await client.query('SELECT * FROM priority_policy_versions ORDER BY version DESC LIMIT 1');
      const proposals=await client.query('SELECT * FROM priority_policy_proposals ORDER BY created_at DESC,id LIMIT 100');
      return {current:current.rows[0],proposals:proposals.rows};
    });
  }
  @Post() async propose(@Headers() h:H,@Body() body:unknown){
    const actor=await this.identity.identity(auth(h),true);
    if(!object(body)||Object.keys(body).some(k=>!['id','expectedVersion','config','reason','contentClass'].includes(k))
      ||!uuid.test(String(body.id))||!Number.isInteger(body.expectedVersion)||Number(body.expectedVersion)<1
      ||!reason(body.reason)||!validPriorityPolicy(body.config))throw new BadRequestException({code:'INVALID_PRIORITY_POLICY'});
    await this.intake.requireGeneral(actor.id,body,'priority-review');
    const config=body.config;
    return this.db.transaction(async client=>{
      await this.lock(client,actor.id);
      const existing=await client.query('SELECT *,config=$2::jsonb AS same FROM priority_policy_proposals WHERE id=$1',[body.id,JSON.stringify(body.config)]);
      if(existing.rowCount){const row=existing.rows[0];if(row.proposed_by!==actor.id||!row.same||row.expected_version!==body.expectedVersion||row.reason!==String(body.reason).trim())
        throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});return row;}
      const current=(await client.query('SELECT max(version) AS version FROM priority_policy_versions')).rows[0];
      if(current.version!==body.expectedVersion)throw new ConflictException({code:'VERSION_CONFLICT'});
      if(config.criticalServices.length){const services=await client.query('SELECT code FROM service_catalog WHERE code=ANY($1::text[])',[config.criticalServices]);
        if(services.rowCount!==config.criticalServices.length)throw new BadRequestException({code:'INVALID_PRIORITY_POLICY'});}
      const inserted=await client.query(`INSERT INTO priority_policy_proposals(id,expected_version,config,proposed_by,reason)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[body.id,body.expectedVersion,JSON.stringify(config),actor.id,String(body.reason).trim()]);
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor.id,'PRIORITY_POLICY_PROPOSED',body.id]);
      return inserted.rows[0];
    });
  }
  @Post(':id/review') async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    const actor=await this.identity.identity(auth(h),true);
    if(!uuid.test(id))throw new NotFoundException();
    if(!object(body)||Object.keys(body).some(k=>!['expectedVersion','decision','reason','contentClass'].includes(k))
      ||!Number.isInteger(body.expectedVersion)||!['APPROVE','REJECT'].includes(String(body.decision))||!reason(body.reason))
      throw new BadRequestException({code:'INVALID_PRIORITY_POLICY'});
    await this.intake.requireGeneral(actor.id,body,'priority-review');
    return this.db.transaction(async client=>{
      await this.lock(client,actor.id);
      const found=await client.query('SELECT * FROM priority_policy_proposals WHERE id=$1 FOR UPDATE',[id]);
      if(!found.rowCount)throw new NotFoundException();const p=found.rows[0];
      if(p.proposed_by===actor.id)throw new ForbiddenException({code:'PRIORITY_INDEPENDENT_REVIEW_REQUIRED'});
      if(p.version!==body.expectedVersion||p.status!=='PENDING')throw new ConflictException({code:'VERSION_CONFLICT'});
      if(body.decision==='APPROVE'){
        const proposer=await client.query(`SELECT 1 FROM employees e JOIN role_bindings r ON r.employee_id=e.id
          WHERE e.id=$1 AND e.active AND r.role_code='PLATFORM_ADMIN' AND r.group_id IS NULL AND ${ROLE_EFFECTIVE_SQL}`,[p.proposed_by]);
        if(!proposer.rowCount)throw new ConflictException({code:'PRIORITY_PROPOSER_UNAVAILABLE'});
        const current=(await client.query('SELECT max(version) AS version FROM priority_policy_versions')).rows[0];
        if(current.version!==p.expected_version)throw new ConflictException({code:'VERSION_CONFLICT'});
        if(p.config.criticalServices.length){const services=await client.query('SELECT code FROM service_catalog WHERE code=ANY($1::text[])',[p.config.criticalServices]);
          if(services.rowCount!==p.config.criticalServices.length)throw new ConflictException({code:'INVALID_PRIORITY_POLICY'});}
        await client.query('INSERT INTO priority_policy_versions(version,config,approved,created_by) VALUES($1,$2,true,$3)',[current.version+1,p.config,actor.id]);
      }
      const updated=await client.query(`UPDATE priority_policy_proposals SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
        [id,body.decision==='APPROVE'?'APPROVED':'REJECTED',actor.id,String(body.reason).trim()]);
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor.id,`PRIORITY_POLICY_${body.decision}`,id]);
      return updated.rows[0];
    });
  }
}
