import { BadRequestException,ConflictException,ForbiddenException,Injectable,NotFoundException,UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import type { ServiceCatalogChange,ServiceStructure,ServiceStructureChange,ServiceStructureOptions,ServiceStructurePreview } from '@itsm/contracts';
import type { Identity } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL } from './role-policy.js';
import { supportDecision } from './support-policy.js';
import { preserveStructureIds,serviceStructure,structureProposal,structureUuid } from './service-structure-policy.js';
import { serviceCatalogChange } from './service-catalog-policy.js';
import { applyCatalogBundle,catalogAdminRows,validateCatalogBundle } from './service-catalog-store.js';
import { ensureAdminMembership } from './admin-membership.js';

type Client=Pick<PoolClient,'query'>;
const columns=`id,expected_version AS "expectedVersion",config,proposed_by AS "proposedBy",reviewed_by AS "reviewedBy",
  status,version,reason,review_reason AS "reviewReason",created_at AS "createdAt",reviewed_at AS "reviewedAt",catalog_change AS "catalogChange",management_mode AS "managementMode"`;

@Injectable()
export class ServiceStructureService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService){}

  private async admin(client:Client,actor:string){
    if(!(await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND ${ROLE_EFFECTIVE_SQL}`,[actor])).rowCount)throw new NotFoundException();
  }

  private async writer(client:PoolClient,actor:string,adminRequired=true){
    await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
      throw new UnauthorizedException({code:'EMPLOYEE_DISABLED'});
    if(adminRequired)await this.admin(client,actor);
    else if(!(await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1
      AND r.role_code IN ('PLATFORM_ADMIN','GROUP_LEAD') AND ${ROLE_EFFECTIVE_SQL}`,[actor])).rowCount)throw new NotFoundException();
  }

  private async proposer(client:Client,actor:string,previous:ServiceStructure,next:ServiceStructure,catalogChange?:ServiceCatalogChange){
    if((await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND ${ROLE_EFFECTIVE_SQL}`,[actor])).rowCount)return;
    if(catalogChange||(['domains','systems','positions','mappings'] as const).some(k=>!isDeepStrictEqual(previous[k],next[k])))
      throw new ForbiddenException({code:'APPOINTMENT_SCOPE_REQUIRED'});
    const groups=(await client.query(`SELECT r.group_id FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='GROUP_LEAD'
      AND ${ROLE_EFFECTIVE_SQL}`,[actor])).rows.map(r=>r.group_id);
    if(!groups.length)throw new ForbiddenException({code:'APPOINTMENT_SCOPE_REQUIRED'});
    for(const a of [...previous.appointments,...next.appointments]){
      const old=previous.appointments.find(r=>r.id===a.id),updated=next.appointments.find(r=>r.id===a.id);
      if(isDeepStrictEqual(old,updated))continue;
      if(!groups.includes(previous.positions.find(p=>p.id===a.positionId)?.groupId))throw new ForbiddenException({code:'APPOINTMENT_SCOPE_REQUIRED'});
      if(updated?.enabled&&updated.employeeId===actor)throw new ForbiddenException({code:'SELF_APPOINTMENT_NOT_ALLOWED'});
    }
  }

  async appointments(actor:Identity){return this.db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
    const isAdmin=!!(await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND ${ROLE_EFFECTIVE_SQL}`,[actor.id])).rowCount;
    const groups=isAdmin?(await client.query('SELECT id AS group_id FROM support_groups WHERE enabled')).rows.map(r=>r.group_id)
      :(await client.query(`SELECT r.group_id FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='GROUP_LEAD'
      AND ${ROLE_EFFECTIVE_SQL}`,[actor.id])).rows.map(r=>r.group_id);
    if(!groups.length&&!isAdmin)throw new NotFoundException();
    const current=await this.current(client),positions=current.config.positions.filter(p=>groups.includes(p.groupId));
    return {version:current.version,canApply:isAdmin,positions,items:current.config.appointments.filter(a=>positions.some(p=>p.id===a.positionId)),
      people:(await client.query(`SELECT e.id,e.display_name AS name,ARRAY(SELECT group_id FROM group_memberships WHERE employee_id=e.id) AS groups
        FROM employees e WHERE e.active AND ($2 OR EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id AND m.group_id=ANY($1::text[]))) ORDER BY e.display_name,e.id LIMIT 1000`,[groups,isAdmin])).rows,
      proposals:(await client.query(`SELECT id,status,reason,review_reason AS "reviewReason",created_at AS "createdAt" FROM service_structure_proposals
        WHERE proposed_by=$1 ORDER BY created_at DESC LIMIT 50`,[actor.id])).rows};});}

  async proposeAppointment(actor:Identity,body:unknown,direct=false){
    const b=body as Record<string,unknown>;
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['id','expectedVersion','appointment','reason','contentClass'].includes(k)))
      throw new BadRequestException({code:'INVALID_SERVICE_STRUCTURE'});
    const current=await this.current(this.db.pool),a=b.appointment as ServiceStructure['appointments'][number];
    if(!a||typeof a!=='object')throw new BadRequestException({code:'INVALID_SERVICE_STRUCTURE'});
    const config={...current.config,appointments:[...current.config.appointments.filter(row=>row.id!==a.id),a]};
    const result=await this.propose(actor,{id:b.id,expectedVersion:b.expectedVersion,config,reason:b.reason,contentClass:b.contentClass},direct);
    return {id:result.id,status:result.status,version:result.version};
  }

  async revokeAppointment(actor:Identity,body:unknown){
    const b=body as Record<string,unknown>;
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['id','expectedVersion','appointmentId','reason','contentClass'].includes(k))
      ||!structureUuid.test(String(b.id))||!Number.isInteger(b.expectedVersion)||typeof b.appointmentId!=='string'
      ||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>500)throw new BadRequestException({code:'INVALID_SERVICE_STRUCTURE'});
    await this.intake.requireGeneral(actor.id,b,'service-structure');
    return this.db.transaction(async client=>{
      await this.writer(client,actor.id,false);
      const old=(await client.query('SELECT * FROM appointment_emergency_revocations WHERE id=$1',[b.id])).rows[0];
      if(old){if(old.actor_id!==actor.id||old.appointment_id!==b.appointmentId||old.expected_version!==b.expectedVersion||old.reason!==String(b.reason).trim())
        throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});return {version:old.published_version};}
      const current=await this.current(client);if(current.version!==b.expectedVersion)throw new ConflictException({code:'SERVICE_STRUCTURE_VERSION_CONFLICT'});
      const a=current.config.appointments.find(a=>a.id===b.appointmentId);if(!a||!a.enabled)throw new NotFoundException();
      const config=serviceStructure({...current.config,appointments:current.config.appointments.map(row=>row.id===a.id?{...row,enabled:false}:row)});
      await this.proposer(client,actor.id,current.config,config);
      const version=current.version+1;
      await client.query('INSERT INTO service_structure_versions(version,config) VALUES($1,$2)',[version,JSON.stringify(config)]);
      await client.query('INSERT INTO appointment_emergency_revocations(id,appointment_id,actor_id,expected_version,published_version,reason) VALUES($1,$2,$3,$4,$5,$6)',
        [b.id,a.id,actor.id,b.expectedVersion,version,String(b.reason).trim()]);
      await client.query('UPDATE service_structure_current SET version=$1 WHERE id=true',[version]);
      await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor.id,'APPOINTMENT_EMERGENCY_REVOKED',b.id]);
      return {version};
    });
  }

  private async current(client:Client):Promise<{version:number;config:ServiceStructure}>{
    return (await client.query(`SELECT c.version,v.config FROM service_structure_current c
      JOIN service_structure_versions v ON v.version=c.version`)).rows[0];
  }

  private async options(client:Client):Promise<ServiceStructureOptions>{
    return {groups:(await client.query('SELECT id,name,enabled FROM support_groups ORDER BY name,id')).rows,
      services:(await client.query(`SELECT code,name,group_id AS "groupId",type,published FROM service_catalog ORDER BY code`)).rows,people:[]};
  }

  async list(actor:Identity){
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
      await this.admin(client,actor.id);
      const current=await this.current(client),options=await this.options(client);
      const changes=await client.query<ServiceStructureChange>(`SELECT ${columns} FROM service_structure_proposals ORDER BY created_at DESC,id DESC LIMIT 101`);
      options.people=(await client.query(`SELECT e.id,e.display_name AS name,e.active,
        ARRAY(SELECT m.group_id FROM group_memberships m WHERE m.employee_id=e.id) AS groups,
        EXISTS(SELECT 1 FROM identity_links l WHERE l.employee_id=e.id AND l.corp_id=$2) AS "dingLinked"
        FROM employees e WHERE e.id=ANY($1::text[]) ORDER BY e.display_name,e.id`,
        [[...new Set([...current.config.appointments,...changes.rows.flatMap(row=>row.config.appointments)].map(row=>row.employeeId)
          .concat(changes.rows.flatMap(row=>[row.proposedBy,...(row.reviewedBy?[row.reviewedBy]:[])])))],process.env.DINGTALK_CORP_ID??''])).rows;
      return {...current,options,items:changes.rows.slice(0,100),hasMore:changes.rows.length>100};
    });
  }

  async people(actor:Identity,q:unknown){
    await this.admin(this.db.pool,actor.id);
    if(typeof q!=='string'||q.length>100)throw new BadRequestException({code:'INVALID_SERVICE_STRUCTURE'});
    if(q.trim().length<2)return {items:[],hasMore:false};
    const people=await this.db.pool.query(`SELECT e.id,e.display_name AS name,
      ARRAY(SELECT m.group_id FROM group_memberships m WHERE m.employee_id=e.id ORDER BY m.group_id) AS groups,
      EXISTS(SELECT 1 FROM identity_links l WHERE l.employee_id=e.id AND l.corp_id=$2) AS "dingLinked"
      FROM employees e WHERE e.active AND (position(lower($1) IN lower(e.id))>0 OR position(lower($1) IN lower(e.display_name))>0)
      ORDER BY e.display_name,e.id LIMIT 51`,[q.trim(),process.env.DINGTALK_CORP_ID??'']);
    return {items:people.rows.slice(0,50),hasMore:people.rows.length>50};
  }

  async catalog(actor:Identity){
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);await this.admin(client,actor.id);
      const current=await this.current(client),options=await this.options(client),rows=await catalogAdminRows(client,actor.id);
      return {...current,options,items:rows.slice(0,500),hasMore:rows.length>500};
    });
  }

  private async validate(client:Client,config:ServiceStructure,previous:ServiceStructure,catalogChange?:ServiceCatalogChange,direct=false):Promise<ServiceStructurePreview[]>{
    preserveStructureIds(previous,config);
    const options=await this.options(client),groups=new Set(options.groups.map(row=>row.id));
    if(catalogChange){
      options.services=options.services.filter(row=>row.code!==catalogChange.code);
      options.services.push({code:catalogChange.code,name:catalogChange.name,groupId:catalogChange.groupId,type:catalogChange.type,published:catalogChange.published});
    }
    if(config.positions.some(row=>!groups.has(row.groupId)))throw new BadRequestException({code:'SERVICE_STRUCTURE_GROUP_UNAVAILABLE'});
    if(config.positions.some(row=>options.groups.find(group=>group.id===row.groupId)?.enabled===false
      &&(row.enabled||previous.positions.find(old=>old.id===row.id)?.groupId!==row.groupId)))
      throw new BadRequestException({code:'SERVICE_STRUCTURE_GROUP_UNAVAILABLE'});
    const employees=await client.query(`SELECT e.id,e.display_name AS name,e.active,
      ARRAY(SELECT m.group_id FROM group_memberships m WHERE m.employee_id=e.id) AS groups,
      EXISTS(SELECT 1 FROM identity_links l WHERE l.employee_id=e.id AND l.corp_id=$2) AS "dingLinked"
      FROM employees e WHERE e.id=ANY($1::text[])`,[[...new Set(config.appointments.map(row=>row.employeeId))],process.env.DINGTALK_CORP_ID??'']);
    const people=new Map<string,{id:string;name:string;active:boolean;groups:string[];dingLinked:boolean}>(employees.rows.map(row=>[row.id,row]));
    const positions=new Map(config.positions.map(row=>[row.id,row]));
    for(const a of config.appointments){
      const person=people.get(a.employeeId),position=positions.get(a.positionId)!;
      if(!person||(a.enabled&&(!person.active||(!direct&&!person.groups.includes(position.groupId)))))
        throw new BadRequestException({code:'SERVICE_STRUCTURE_PERSON_UNAVAILABLE'});
      if(a.enabled&&process.env.NOTIFICATION_MODE==='dingtalk'&&!person.dingLinked)
        throw new BadRequestException({code:'SERVICE_STRUCTURE_DING_ID_REQUIRED'});
    }
    // Appointment periods may touch but cannot overlap for the same person and position.
    const periods=new Map<string,typeof config.appointments>();
    for(const a of config.appointments.filter(row=>row.enabled)){
      const key=JSON.stringify([a.positionId,a.employeeId]),existing=periods.get(key)??[];
      if(existing.some(row=>Date.parse(row.validFrom)<Date.parse(a.validTo)&&Date.parse(a.validFrom)<Date.parse(row.validTo)))
        throw new BadRequestException({code:'SERVICE_STRUCTURE_APPOINTMENT_OVERLAP'});
      existing.push(a);periods.set(key,existing);
    }
    const clock=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    return config.mappings.map(mapping=>{
      const service=options.services.find(row=>row.code===mapping.serviceCode),position=positions.get(mapping.primaryPositionId)!;
      if(!service)throw new BadRequestException({code:'SERVICE_STRUCTURE_SERVICE_UNAVAILABLE'});
      // Catalog ownership may change only through the explicit reviewed bundle.
      if(mapping.enabled&&position.groupId!==service.groupId)throw new BadRequestException({code:'SERVICE_STRUCTURE_GROUP_MISMATCH'});
      const candidates=config.appointments.filter(a=>a.enabled&&a.positionId===position.id&&Date.parse(a.validFrom)<=clock&&clock<Date.parse(a.validTo))
        .map(a=>({id:a.employeeId,name:people.get(a.employeeId)!.name,duty:a.duty,dingLinked:people.get(a.employeeId)!.dingLinked}))
        .sort((a,b)=>Number(a.duty==='BACKUP')-Number(b.duty==='BACKUP')||a.id.localeCompare(b.id));
      const warnings:string[]=[];
      if(mapping.enabled&&!candidates.length)warnings.push('NO_CURRENT_APPOINTEE');
      if(candidates.some(row=>!row.dingLinked))warnings.push('DING_ID_NOT_LINKED');
      if(!service.published)warnings.push('CATALOG_NOT_PUBLISHED');
      return {serviceCode:mapping.serviceCode,groupId:position.groupId,primaryPositionId:position.id,enabled:mapping.enabled,candidates,warnings};
    });
  }

  async preview(actor:Identity,body:unknown){
    const input=structureProposal(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'service-structure');
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);await this.admin(client,actor.id);
      const current=await this.current(client);
      if(current.version!==input.expectedVersion)throw new ConflictException({code:'SERVICE_STRUCTURE_VERSION_CONFLICT'});
      if(input.catalogChange)await validateCatalogBundle(client,actor.id,input.catalogChange,input.config,true);
      return {items:await this.validate(client,input.config,current.config,input.catalogChange,true)};
    });
  }

  async propose(actor:Identity,body:unknown,direct=false){
    const input=structureProposal(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'service-structure');
    return this.db.transaction(async client=>{
      await this.writer(client,actor.id,false);
      if(direct)await this.admin(client,actor.id);
      const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const old=await client.query(`SELECT ${columns},request_hash FROM service_structure_proposals WHERE id=$1`,[input.id]);
      if(old.rowCount){
        if(old.rows[0].request_hash!==hash||old.rows[0].proposedBy!==actor.id||old.rows[0].managementMode!==(direct?'ADMIN_DIRECT':'REVIEW'))throw new ConflictException({code:'SERVICE_STRUCTURE_ID_CONFLICT'});
        const {request_hash:_,...result}=old.rows[0];return result;
      }
      const current=await this.current(client);
      if(current.version!==input.expectedVersion)throw new ConflictException({code:'SERVICE_STRUCTURE_VERSION_CONFLICT'});
      await this.proposer(client,actor.id,current.config,input.config,input.catalogChange);
      const catalogBase=input.catalogChange?await validateCatalogBundle(client,actor.id,input.catalogChange,input.config,direct):undefined;
      await this.validate(client,input.config,current.config,input.catalogChange,direct);
      const row=await client.query(`INSERT INTO service_structure_proposals(id,expected_version,config,request_hash,proposed_by,reason,catalog_change,catalog_base,management_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${columns}`,[input.id,input.expectedVersion,JSON.stringify(input.config),hash,actor.id,input.reason,
          input.catalogChange?JSON.stringify(input.catalogChange):null,catalogBase?JSON.stringify(catalogBase):null,direct?'ADMIN_DIRECT':'REVIEW']);
      await this.audit(client,input.id,actor.id,'PROPOSED',null,input.reason);
      if(direct)return this.applyDecision(client,actor,input.id,{expectedVersion:row.rows[0].version,decision:'APPROVE',reason:input.reason},true);
      return row.rows[0];
    });
  }

  private affected(previous:ServiceStructure,next:ServiceStructure):Set<string>{
    const changedPositions=new Set<string>(),people=new Set<string>();
    for(const p of next.positions)if(!isDeepStrictEqual(p,previous.positions.find(row=>row.id===p.id)))changedPositions.add(p.id);
    for(const mapping of next.mappings){
      const old=previous.mappings.find(row=>row.serviceCode===mapping.serviceCode);
      if(!isDeepStrictEqual(mapping,old))for(const m of [mapping,old])if(m){
        changedPositions.add(m.primaryPositionId);m.collaboratingPositionIds.forEach(id=>changedPositions.add(id));
      }
    }
    for(const a of [...previous.appointments,...next.appointments]){
      const old=previous.appointments.find(row=>row.id===a.id),newer=next.appointments.find(row=>row.id===a.id);
      if(changedPositions.has(a.positionId)||!isDeepStrictEqual(old,newer))people.add(a.employeeId);
    }
    return people;
  }

  async review(actor:Identity,id:string,body:unknown){
    if(!structureUuid.test(id))throw new NotFoundException();
    const input=supportDecision(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'service-structure');
    return this.db.transaction(async client=>{
      await this.writer(client,actor.id);
      return this.applyDecision(client,actor,id,input);
    });
  }

  private async applyDecision(client:PoolClient,actor:Identity,id:string,input:{expectedVersion:number;decision:'APPROVE'|'REJECT';reason:string},direct=false){
      const result=await client.query<ServiceStructureChange>(`SELECT ${columns} FROM service_structure_proposals WHERE id=$1 FOR UPDATE`,[id]);
      if(!result.rowCount)throw new NotFoundException();
      const p=result.rows[0];
      if(!direct&&p.proposedBy===actor.id)throw new ForbiddenException({code:'SERVICE_STRUCTURE_INDEPENDENT_REVIEW_REQUIRED'});
      if(p.status!=='PENDING'){
        if(p.version===input.expectedVersion+1&&p.reviewedBy===actor.id&&p.status===(input.decision==='APPROVE'?'APPROVED':'REJECTED')&&p.reviewReason===input.reason)return p;
        throw new ConflictException({code:'SERVICE_STRUCTURE_VERSION_CONFLICT'});
      }
      if(p.version!==input.expectedVersion)throw new ConflictException({code:'SERVICE_STRUCTURE_VERSION_CONFLICT'});
      let published:number|null=null;
      if(input.decision==='APPROVE'){
        const current=await this.current(client),config=serviceStructure(p.config);
        if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[p.proposedBy])).rowCount)
          throw new ConflictException({code:'SERVICE_STRUCTURE_PROPOSER_UNAVAILABLE'});
        await this.proposer(client,p.proposedBy,current.config,config,p.catalogChange??undefined);
        if(current.version!==p.expectedVersion)throw new ConflictException({code:'SERVICE_STRUCTURE_VERSION_CONFLICT'});
        if(!direct&&this.affected(current.config,config).has(actor.id))throw new ForbiddenException({code:'SERVICE_STRUCTURE_INDEPENDENT_REVIEW_REQUIRED'});
        const catalogChange=p.catalogChange?serviceCatalogChange(p.catalogChange):undefined;
        if(catalogChange){
          if(!direct&&(catalogChange.initialPublisherId===actor.id||catalogChange.approval?.steps.some(step=>step.approverId===actor.id)))
            throw new ForbiddenException({code:'SERVICE_STRUCTURE_INDEPENDENT_REVIEW_REQUIRED'});
          await validateCatalogBundle(client,p.proposedBy,catalogChange,config,direct);
          const unchanged=await client.query(`SELECT catalog_base IS NOT DISTINCT FROM
            (SELECT to_jsonb(c) FROM service_catalog c WHERE c.code=$2) AS unchanged FROM service_structure_proposals WHERE id=$1`,[id,catalogChange.code]);
          if(!unchanged.rows[0].unchanged)throw new ConflictException({code:'FORM_VERSION_CONFLICT'});
        }
        const preview=await this.validate(client,config,current.config,catalogChange,direct);
        if(preview.some(row=>row.enabled&&!row.candidates.length))throw new ConflictException({code:'SERVICE_STRUCTURE_COVERAGE_REQUIRED'});
        if(direct)for(const appointment of config.appointments.filter(a=>a.enabled)){
          const position=config.positions.find(p=>p.id===appointment.positionId)!;
          await ensureAdminMembership(client,actor.id,appointment.employeeId,position.groupId,input.reason);
        }
        published=current.version+1;
        await client.query('INSERT INTO service_structure_versions(version,config,proposal_id) VALUES($1,$2,$3)',[published,JSON.stringify(config),id]);
        if(catalogChange)await applyCatalogBundle(client,p.proposedBy,id,published,catalogChange);
        await client.query('UPDATE service_structure_current SET version=$1 WHERE id=true',[published]);
      }
      const updated=await client.query(`UPDATE service_structure_proposals SET status=$2,reviewed_by=$3,review_reason=$4,
        reviewed_at=now(),version=version+1 WHERE id=$1 RETURNING ${columns}`,[id,input.decision==='APPROVE'?'APPROVED':'REJECTED',actor.id,input.reason]);
      await this.audit(client,id,actor.id,input.decision==='APPROVE'?'APPROVED':'REJECTED',published,input.reason);
      return updated.rows[0];
  }

  private async audit(client:PoolClient,id:string,actor:string,action:string,version:number|null,reason:string){
    await client.query(`INSERT INTO service_structure_audits(proposal_id,actor_id,action,published_version,reason) VALUES($1,$2,$3,$4,$5)`,[id,actor,action,version,reason]);
    await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES($1,$2,$3)',[actor,`SERVICE_STRUCTURE_${action}`,id]);
  }

  async history(actor:Identity,id:string){
    await this.admin(this.db.pool,actor.id);
    if(!structureUuid.test(id))throw new NotFoundException();
    return {items:(await this.db.pool.query(`SELECT actor_id AS "actorId",action,published_version AS "publishedVersion",reason,
      created_at AS "createdAt" FROM service_structure_audits WHERE proposal_id=$1 ORDER BY created_at,id`,[id])).rows};
  }
}
