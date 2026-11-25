import {BadRequestException,ConflictException,Injectable,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {catalogTreePath,type CatalogTreeNode,type CatalogTreeView,type CatalogNavigationEntry,type CatalogNavigationView} from '@itsm/contracts';
import type {Identity} from './auth.service.js';
import {Database} from './database.service.js';
import {IntakePolicyService} from './intake-policy.service.js';
import {ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL} from './role-policy.js';
import {catalogNavigationInput,initialCatalogPath} from './catalog-navigation-policy.js';
import {catalogTreeInput} from './catalog-tree-policy.js';
import {currentCatalogTree,directoryState} from './catalog-tree-store.js';
import {initialCatalogTree} from './catalog-tree-bootstrap.js';

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
      if(await currentCatalogTree(client))throw new ConflictException({code:'CATALOG_TREE_EDITOR_REQUIRED'});
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

  private async treeView(client:PoolClient):Promise<CatalogTreeView>{
    const tree=await currentCatalogTree(client);
    const navigation=(await client.query('SELECT version,config FROM catalog_navigation_versions ORDER BY version DESC LIMIT 1')).rows[0];
    const structure=(await client.query('SELECT version FROM service_structure_current')).rows[0];
    const systems=(await client.query('SELECT id,name,enabled FROM business_systems ORDER BY name,id')).rows;
    const services=(await client.query(`SELECT c.code,c.name,c.published,c.group_id AS "groupId",c.form_version AS "formVersion",
      r."systemId" AS "systemId",r.enabled AS mapped,
      EXISTS(SELECT 1 FROM position_appointments a JOIN employees e ON e.id=a."employeeId" AND e.active
        WHERE a.enabled AND a."validFrom"<=clock_timestamp() AND (a."validTo" IS NULL OR a."validTo">clock_timestamp())
          AND a."positionId"=r."primaryPositionId" AND service_position_eligible(
            jsonb_build_object('version',r.version,'domainId',r."domainId",'systemId',r."systemId",'primaryPositionId',r."primaryPositionId",
              'positions',jsonb_build_array(jsonb_build_object('id',p.id,'name',p.name,'groupId',p."groupId"))),e.id,c.group_id)) AS staffed
      FROM service_catalog c LEFT JOIN service_position_routes r ON r."serviceCode"=c.code
      LEFT JOIN support_positions p ON p.id=r."primaryPositionId" ORDER BY c.sort_order,c.code`)).rows;
    if(tree)return {version:tree.version,navigationVersion:navigation.version,structureVersion:structure.version,nodes:tree.nodes,systems,services};
    const nodes=initialCatalogTree(services,systems,navigation.config);
    return {version:0,navigationVersion:navigation.version,structureVersion:structure.version,nodes,systems,services};
  }

  async tree(actor:Identity){return this.db.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
    await this.admin(client,actor.id);return this.treeView(client);
  });}

  private validateTree(input:ReturnType<typeof catalogTreeInput>,view:CatalogTreeView){
    if(input.expectedVersion!==view.version||input.navigationVersion!==view.navigationVersion||input.structureVersion!==view.structureVersion)
      throw new ConflictException({code:'CATALOG_TREE_VERSION_CONFLICT'});
    const byId=new Map(input.nodes.map(n=>[n.id,n]));
    if(view.version>0)for(const old of view.nodes){
      const next=byId.get(old.id);
      if(!next)throw new BadRequestException({code:'CATALOG_TREE_DISABLE_INSTEAD_OF_DELETE'});
      if(next.kind!==old.kind||old.serviceCode&&next.serviceCode!==old.serviceCode||old.systemId&&next.systemId!==old.systemId)
        throw new BadRequestException({code:'CATALOG_TREE_IDENTITY_IMMUTABLE'});
    }
    for(const node of input.nodes){
      if(node.systemId&&!view.systems.some(s=>s.id===node.systemId&&(!node.enabled||s.enabled)))
        throw new BadRequestException({code:'CATALOG_TREE_SYSTEM_UNAVAILABLE'});
      if(node.serviceCode){
        const service=view.services.find(s=>s.code===node.serviceCode);
        if(!service)throw new BadRequestException({code:'CATALOG_TREE_SERVICE_UNAVAILABLE'});
        const state=directoryState({version:view.version+1,nodes:input.nodes},service.code,service.systemId);
        if(state.reason==='SYSTEM_MAPPING_MISMATCH')throw new BadRequestException({code:state.reason,serviceCode:service.code});
      }
    }
    for(const service of view.services){
      if(!input.nodes.some(n=>n.serviceCode===service.code))
        throw new BadRequestException({code:'CATALOG_TREE_SERVICE_UNASSIGNED',serviceCode:service.code});
    }
  }

  private async treeReadiness(client:PoolClient,input:ReturnType<typeof catalogTreeInput>,view:CatalogTreeView){
    const rows=[];
    for(const service of view.services){
      const state=directoryState({version:view.version+1,nodes:input.nodes},service.code,service.systemId);
      const candidates=(await client.query(`SELECT DISTINCT e.id,e.display_name AS name,a.duty FROM service_position_routes r
        JOIN support_positions p ON p.id=r."primaryPositionId" JOIN position_appointments a ON a."positionId"=p.id
        JOIN employees e ON e.id=a."employeeId" AND e.active
        WHERE r."serviceCode"=$1 AND r.enabled AND a.enabled AND a."validFrom"<=clock_timestamp()
          AND (a."validTo" IS NULL OR a."validTo">clock_timestamp()) AND service_position_eligible(
            jsonb_build_object('version',r.version,'domainId',r."domainId",'systemId',r."systemId",'primaryPositionId',r."primaryPositionId",
              'positions',jsonb_build_array(jsonb_build_object('id',p.id,'name',p.name,'groupId',p."groupId"))),e.id,$2)
        ORDER BY a.duty,e.id`,[service.code,service.groupId])).rows;
      rows.push({serviceCode:service.code,path:state.navigation?.path??[],groupId:service.groupId,candidates,
        warnings:[...(!service.published?['UNPUBLISHED']:[]),...(state.reason?[state.reason]:[]),...(!service.mapped?['ROUTE_UNAVAILABLE']:[]),...(!candidates.length?['NO_ACTIVE_ENGINEER']:[])]});
    }
    return rows;
  }

  async previewTree(actor:Identity,body:unknown){
    const input=catalogTreeInput(body);
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);await this.admin(client,actor.id);
      const view=await this.treeView(client);this.validateTree(input,view);
      return {items:await this.treeReadiness(client,input,view)};
    });
  }

  async saveTree(actor:Identity,body:unknown){
    const input=catalogTreeInput(body);
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);await this.admin(client,actor.id);
      await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'catalog-navigation');
      await client.query('SELECT pg_advisory_xact_lock(71820548)');
      const view=await this.treeView(client);this.validateTree(input,view);
      const items=input.nodes.filter(n=>n.kind==='SERVICE'&&n.serviceCode).map(node=>({serviceCode:node.serviceCode!,
        path:catalogTreePath(input.nodes,node.serviceCode!)!.slice(0,-1).map(n=>n.name),sortOrder:node.sortOrder}));
      const version=view.version+1,navigationVersion=view.navigationVersion+1;
      await client.query('INSERT INTO catalog_navigation_versions(version,config,actor_id,reason) VALUES($1,$2,$3,$4)',[navigationVersion,JSON.stringify(items),actor.id,input.reason]);
      await client.query(`INSERT INTO catalog_tree_versions(version,nodes,navigation_version,structure_version,actor_id,reason)
        VALUES($1,$2,$3,$4,$5,$6)`,[version,JSON.stringify(input.nodes),navigationVersion,view.structureVersion,actor.id,input.reason]);
      return {version,navigationVersion};
    });
  }
}
