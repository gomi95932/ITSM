import {ConflictException,Injectable,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {CatalogNavigationEntry,CatalogNavigationView} from '@itsm/contracts';
import type {Identity} from './auth.service.js';
import {Database} from './database.service.js';
import {IntakePolicyService} from './intake-policy.service.js';
import {ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL} from './role-policy.js';
import {catalogNavigationInput,initialCatalogPath} from './catalog-navigation-policy.js';

@Injectable()
export class CatalogNavigationService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService){}
  private async admin(client:PoolClient,id:string){
    if(!(await client.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN'
      AND ${ROLE_EFFECTIVE_SQL}`,[id])).rowCount)throw new NotFoundException();
  }
  async list(actor:Identity):Promise<CatalogNavigationView>{return this.db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
    await this.admin(client,actor.id);
    const current=(await client.query<{version:number;config:CatalogNavigationEntry[]}>(
      'SELECT version,config FROM catalog_navigation_versions ORDER BY version DESC LIMIT 1')).rows[0];
    const services=(await client.query(`SELECT c.code,c.name,c.published,
      (SELECT s.name FROM service_position_routes r JOIN business_systems s ON s.id=r."systemId"
        WHERE r."serviceCode"=c.code LIMIT 1) AS system_name,
      EXISTS(SELECT 1 FROM service_position_routes r JOIN support_positions p ON p.id=r."primaryPositionId"
        JOIN service_domains d ON d.id=p."domainId" AND d.enabled
        JOIN support_groups g ON g.id=p."groupId" AND g.enabled
        WHERE r."serviceCode"=c.code AND r.enabled AND p.enabled AND p."groupId"=c.group_id) AS mapped,
      EXISTS(SELECT 1 FROM service_position_routes r JOIN support_positions p ON p.id=r."primaryPositionId"
        JOIN service_domains d ON d.id=p."domainId" AND d.enabled
        JOIN support_groups g ON g.id=p."groupId" AND g.enabled
        JOIN position_appointments a ON a."positionId"=p.id JOIN employees e ON e.id=a."employeeId"
        JOIN group_memberships m ON m.employee_id=e.id AND m.group_id=p."groupId"
        WHERE r."serviceCode"=c.code AND r.enabled AND p.enabled AND p."groupId"=c.group_id
          AND a.enabled AND e.active AND a."validFrom"<=clock_timestamp()
          AND (a."validTo" IS NULL OR a."validTo">clock_timestamp())) AS staffed
      FROM service_catalog c ORDER BY c.sort_order,c.code`)).rows;
    const entries=new Map(current.config.map(item=>[item.serviceCode,item]));
    const history=(await client.query(`SELECT v.version,e.display_name AS "actorName",v.reason,v.created_at AS "createdAt"
      FROM catalog_navigation_versions v LEFT JOIN employees e ON e.id=v.actor_id ORDER BY v.version DESC LIMIT 20`)).rows;
    return {version:current.version,services:services.map(({system_name,...service})=>service),history,
      items:services.map((service,index)=>entries.get(service.code)
      ??{serviceCode:service.code,path:initialCatalogPath(service.code,service.system_name),sortOrder:Math.min(index*10,99999)})};
  });}
  async save(actor:Identity,body:unknown){
    const input=catalogNavigationInput(body);
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
      await this.admin(client,actor.id);
      await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'catalog-navigation');
      await client.query('SELECT pg_advisory_xact_lock(71820548)');
      const current=(await client.query('SELECT version FROM catalog_navigation_versions ORDER BY version DESC LIMIT 1')).rows[0];
      if(current.version!==input.expectedVersion)throw new ConflictException({code:'CATALOG_NAVIGATION_VERSION_CONFLICT'});
      const codes=(await client.query<{code:string}>('SELECT code FROM service_catalog ORDER BY code FOR SHARE')).rows.map(r=>r.code);
      // Full snapshots prevent a stale editor from silently dropping newly added services.
      if(codes.length!==input.items.length||input.items.some(item=>!codes.includes(item.serviceCode)))
        throw new ConflictException({code:'CATALOG_NAVIGATION_SERVICES_CHANGED'});
      const version=current.version+1;
      await client.query('INSERT INTO catalog_navigation_versions(version,config,actor_id,reason) VALUES($1,$2,$3,$4)',
        [version,JSON.stringify(input.items),actor.id,input.reason]);
      return {version};
    });
  }
}
