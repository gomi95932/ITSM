import { BadRequestException,Body,ConflictException,Controller,ForbiddenException,Get,Headers,NotFoundException,Param,Post } from '@nestjs/common';
import { validOperationsConfig,type OperationsConfig } from '@itsm/contracts';
import type { PoolClient } from 'pg';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL } from './role-policy.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const obj=(b:unknown):b is Record<string,unknown>=>!!b&&typeof b==='object'&&!Array.isArray(b);
const reason=(r:unknown):r is string=>typeof r==='string'&&!!r.trim()&&r.length<=500;
@Controller('admin/operations')
export class OperationsController {
  constructor(private readonly db:Database,private readonly identity:AuthService,private readonly intake:IntakePolicyService){}
  private async admin(c:PoolClient,actor:string){
    if(!(await c.query(`SELECT e.id FROM employees e JOIN role_bindings r ON r.employee_id=e.id
      WHERE e.id=$1 AND e.active AND r.role_code='PLATFORM_ADMIN' AND r.group_id IS NULL AND ${ROLE_EFFECTIVE_SQL} FOR SHARE OF e`,[actor])).rowCount)
      throw new ForbiddenException({code:'PLATFORM_ADMIN_REQUIRED'});
  }
  private async lock(c:PoolClient,actor:string){await c.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);await this.admin(c,actor);}
  private async validate(c:PoolClient,config:OperationsConfig,previous:OperationsConfig){
    if(previous.siteEnforced&&!config.siteEnforced)throw new ConflictException({code:'SITE_ISOLATION_CANNOT_BE_DISABLED'});
    if(!previous.siteEnforced&&config.siteEnforced&&(await c.query(`SELECT 1 FROM tickets
      WHERE status NOT IN ('CLOSED','CANCELLED','REJECTED') AND service_routing_snapshot->'site'->>'id' IS NULL LIMIT 1`)).rowCount)
      throw new ConflictException({code:'SITE_LEGACY_TICKETS_REQUIRE_CLOSURE'});
    for(const site of previous.sites)if(!config.sites.some(s=>s.id===site.id))throw new ConflictException({code:'HISTORICAL_SITE_REQUIRED'});
    const refs:[string,string,string[]][]=[['employees','id',config.employeeSites.map(e=>e.employeeId)],
      ['support_groups','id',config.groupSites.map(g=>g.groupId)],['support_positions','id',config.positionSites.map(p=>p.positionId)],
      ['service_catalog','code',[...config.serviceSites,...config.serviceSlas].map(s=>s.serviceCode)]];
    for(const [table,column,ids] of refs){const found=await c.query(`SELECT ${column} FROM ${table} WHERE ${column}=ANY($1::text[])`,[ids]);
      if(new Set(found.rows.map(r=>r[column])).size!==new Set(ids).size)throw new BadRequestException({code:'OPERATIONS_REFERENCE_NOT_FOUND'});}
    await c.query('SELECT id FROM employees WHERE id=ANY($1::text[]) FOR SHARE',[config.employeeSites.map(e=>e.employeeId)]);
    for(const route of config.siteRoutes){
      const p=(await c.query(`SELECT p.* FROM support_positions p JOIN service_domains d ON d.id=p."domainId" AND d.enabled
        JOIN support_groups g ON g.id=p."groupId" AND g.enabled WHERE p.id=$1 AND p.enabled`,[route.positionId])).rows[0];
      if(!p||!config.groupSites.some(g=>g.groupId===p.groupId&&g.siteIds.includes(route.siteId)))
        throw new BadRequestException({code:'SITE_ROUTE_GROUP_SCOPE_REQUIRED'});
      const service=(await c.query('SELECT type,group_id FROM service_catalog WHERE code=$1',[route.serviceCode])).rows[0];
      if(service?.type==='REQ'&&service.group_id!==p.groupId)
        throw new BadRequestException({code:'SITE_REQUEST_APPROVED_GROUP_REQUIRED'});
    }
    if(config.siteEnforced){
      const services=(await c.query('SELECT code FROM service_catalog WHERE published')).rows;
      for(const s of services){const scope=config.serviceSites.find(r=>r.serviceCode===s.code);
        if(!scope||scope.siteIds.some(siteId=>!config.siteRoutes.some(r=>r.serviceCode===s.code&&r.siteId===siteId)))
          throw new BadRequestException({code:'SITE_ROUTE_COVERAGE_REQUIRED'});}
    }
  }
  @Get() async list(@Headers() h:H){const actor=await this.identity.identity(auth(h));return this.db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);await this.admin(c,actor.id);
    return {current:(await c.query('SELECT * FROM operations_current')).rows[0],
      proposals:(await c.query("SELECT * FROM operations_proposals ORDER BY (status='PENDING') DESC,created_at DESC,id LIMIT 100")).rows,
      history:(await c.query('SELECT version,created_at,created_by FROM operations_versions ORDER BY version DESC LIMIT 100')).rows,
      groups:(await c.query('SELECT id,name FROM support_groups WHERE enabled ORDER BY name')).rows,
      positions:(await c.query('SELECT id,name,"groupId" FROM support_positions WHERE enabled ORDER BY name')).rows,
      services:(await c.query('SELECT code,name FROM service_catalog ORDER BY code')).rows,
      people:(await c.query('SELECT id,display_name AS name FROM employees WHERE active ORDER BY display_name,id LIMIT 3001')).rows};});}
  @Post() async propose(@Headers() h:H,@Body() b:unknown){const actor=await this.identity.identity(auth(h),true);
    if(!obj(b)||Object.keys(b).some(k=>!['id','expectedVersion','config','reason','contentClass'].includes(k))
      ||!uuid.test(String(b.id))||!Number.isInteger(b.expectedVersion)||!reason(b.reason)||!validOperationsConfig(b.config))
      throw new BadRequestException({code:'INVALID_OPERATIONS_CONFIG'});
    await this.intake.requireGeneral(actor.id,b,'operations');const config=b.config;
    return this.db.transaction(async c=>{await this.lock(c,actor.id);
      const prior=(await c.query('SELECT *,config=$2::jsonb AS same FROM operations_proposals WHERE id=$1',[b.id,JSON.stringify(config)])).rows[0];
      if(prior){if(prior.proposed_by!==actor.id||!prior.same||prior.expected_version!==b.expectedVersion||prior.reason!==String(b.reason).trim())
        throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});return prior;}
      const current=(await c.query('SELECT * FROM operations_current')).rows[0];
      if(current.version!==b.expectedVersion)throw new ConflictException({code:'VERSION_CONFLICT'});
      await this.validate(c,config,current.config);
      const result=(await c.query(`INSERT INTO operations_proposals(id,expected_version,config,proposed_by,reason)
        VALUES($1,$2,$3,$4,$5) RETURNING *`,[b.id,b.expectedVersion,JSON.stringify(config),actor.id,String(b.reason).trim()])).rows[0];
      await c.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor.id,'OPERATIONS_PROPOSED',b.id]);return result;});}
  @Post(':id/review') async review(@Headers() h:H,@Param('id') id:string,@Body() b:unknown){const actor=await this.identity.identity(auth(h),true);
    if(!uuid.test(id))throw new NotFoundException();
    if(!obj(b)||Object.keys(b).some(k=>!['expectedVersion','decision','reason','contentClass'].includes(k))
      ||!Number.isInteger(b.expectedVersion)||!['APPROVE','REJECT'].includes(String(b.decision))||!reason(b.reason))throw new BadRequestException({code:'INVALID_OPERATIONS_CONFIG'});
    await this.intake.requireGeneral(actor.id,b,'operations');
    return this.db.transaction(async c=>{await this.lock(c,actor.id);
      const p=(await c.query('SELECT * FROM operations_proposals WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!p)throw new NotFoundException();
      if(p.proposed_by===actor.id)throw new ForbiddenException({code:'OPERATIONS_INDEPENDENT_REVIEW_REQUIRED'});
      if(p.status!=='PENDING'&&p.version===Number(b.expectedVersion)+1&&p.reviewed_by===actor.id
        &&p.status===(b.decision==='APPROVE'?'APPROVED':'REJECTED')&&p.review_reason===String(b.reason).trim())return p;
      if(p.status!=='PENDING'||p.version!==b.expectedVersion)throw new ConflictException({code:'VERSION_CONFLICT'});
      if(b.decision==='APPROVE'){
        await this.admin(c,p.proposed_by);const current=(await c.query('SELECT * FROM operations_current')).rows[0];
        if(current.version!==p.expected_version)throw new ConflictException({code:'VERSION_CONFLICT'});
        if(!validOperationsConfig(p.config))throw new BadRequestException({code:'INVALID_OPERATIONS_CONFIG'});
        await this.validate(c,p.config,current.config);
        const own=(cfg:OperationsConfig)=>cfg.employeeSites.find(e=>e.employeeId===actor.id);
        if(JSON.stringify(own(current.config))!==JSON.stringify(own(p.config)))throw new ForbiddenException({code:'OPERATIONS_INDEPENDENT_REVIEW_REQUIRED'});
        await c.query('INSERT INTO operations_versions(version,config,created_by) VALUES($1,$2,$3)',[current.version+1,p.config,actor.id]);
      }
      const result=(await c.query(`UPDATE operations_proposals SET status=$2,reviewed_by=$3,review_reason=$4,reviewed_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
        [id,b.decision==='APPROVE'?'APPROVED':'REJECTED',actor.id,String(b.reason).trim()])).rows[0];
      await c.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor.id,`OPERATIONS_${b.decision}`,id]);return result;});}
}
