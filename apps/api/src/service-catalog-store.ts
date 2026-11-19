import { BadRequestException,ConflictException,ForbiddenException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ServiceCatalogChange,ServiceStructure } from '@itsm/contracts';

type Client=Pick<PoolClient,'query'>;
type CatalogRow={code:string;type:string;form_version:number;published:boolean;name:string;description:string;group_id:string;
  visible_groups:string[];field_schema:ServiceCatalogChange['fields'];sort_order:number};

export async function validateCatalogBundle(client:Client,actor:string,change:ServiceCatalogChange,config:ServiceStructure){
  const current=await client.query<CatalogRow>('SELECT * FROM service_catalog WHERE code=$1',[change.code]);
  const row=current.rows[0];
  if((row?.form_version??0)!==change.expectedVersion)throw new ConflictException({code:'FORM_VERSION_CONFLICT'});
  if(row&&row.type!==change.type)throw new BadRequestException({code:'CATALOG_TYPE_IMMUTABLE'});
  const groups=[...new Set([change.groupId,...change.visibleGroups])];
  const found=await client.query<{id:string;enabled:boolean}>('SELECT id,enabled FROM support_groups WHERE id=ANY($1::text[])',[groups]);
  const previousGroups=row?[row.group_id,...row.visible_groups]:[];
  if(found.rowCount!==groups.length||found.rows.some(group=>!group.enabled&&(change.published||!previousGroups.includes(group.id))))
    throw new BadRequestException({code:'CATALOG_GROUP_UNAVAILABLE'});
  const mapping=config.mappings.find(item=>item.serviceCode===change.code);
  if(!mapping||mapping.enabled!==change.published||config.positions.find(p=>p.id===mapping.primaryPositionId)?.groupId!==change.groupId)
    throw new BadRequestException({code:'CATALOG_ROUTING_BUNDLE_REQUIRED'});
  if(change.type==='REQ'){
    if(!row){
      if(change.initialPublisherId!==actor||!(await client.query(`SELECT 1 FROM group_memberships m JOIN employees e ON e.id=m.employee_id
        WHERE m.employee_id=$1 AND m.group_id=$2 AND e.active`,[actor,change.groupId])).rowCount)
        throw new ForbiddenException({code:'CATALOG_INITIAL_PUBLISHER_REQUIRED'});
    }else if(!(await client.query(`SELECT 1 FROM request_catalog_publishers p JOIN employees e ON e.id=p.employee_id
      WHERE p.service_code=$1 AND p.employee_id=$2 AND e.active`,[change.code,actor])).rowCount)
      throw new ForbiddenException({code:'CATALOG_PUBLISHER_REQUIRED'});
    const ids=change.approval!.steps.flatMap(step=>step.approverId?[step.approverId]:[]);
    if(new Set(ids).size!==ids.length)throw new BadRequestException({code:'DUPLICATE_APPROVER'});
    if(ids.length&&(await client.query('SELECT id FROM employees WHERE id=ANY($1::text[]) AND active',[ids])).rowCount!==ids.length)
      throw new BadRequestException({code:'APPROVER_UNAVAILABLE'});
  }
  return row;
}

export async function applyCatalogBundle(client:PoolClient,actor:string,proposalId:string,structureVersion:number,change:ServiceCatalogChange){
  const version=change.expectedVersion+1;
  if(change.type==='REQ'&&change.expectedVersion>0){
    await client.query(`INSERT INTO request_catalog_versions(service_code,form_version,snapshot)
      SELECT code,form_version,jsonb_build_object('code',code,'formVersion',form_version,'published',published,'name',name,
        'description',description,'groupId',group_id,'visibleGroups',visible_groups,'fields',field_schema,'approval',null)
      FROM service_catalog WHERE code=$1 ON CONFLICT DO NOTHING`,[change.code]);
  }
  await client.query(`INSERT INTO service_catalog(code,type,form_version,published,group_id,required_fields,name,description,visible_groups,field_schema,sort_order)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(code) DO UPDATE SET form_version=excluded.form_version,published=excluded.published,group_id=excluded.group_id,
      required_fields=excluded.required_fields,name=excluded.name,description=excluded.description,visible_groups=excluded.visible_groups,
      field_schema=excluded.field_schema,sort_order=excluded.sort_order`,
    [change.code,change.type,version,change.published,change.groupId,JSON.stringify(change.fields.filter(f=>f.required).map(f=>f.key)),
      change.name,change.description,JSON.stringify(change.visibleGroups),JSON.stringify(change.fields),change.sortOrder]);
  const snapshot={code:change.code,type:change.type,formVersion:version,published:change.published,name:change.name,description:change.description,
    groupId:change.groupId,visibleGroups:change.visibleGroups,fields:change.fields,approval:change.approval,maxValidityDays:change.maxValidityDays,
    sortOrder:change.sortOrder,initialPublisherId:change.initialPublisherId};
  if(change.type==='REQ'){
    await client.query(`INSERT INTO request_catalog_versions(service_code,form_version,snapshot,published_by) VALUES($1,$2,$3,$4)`,
      [change.code,version,JSON.stringify(snapshot),actor]);
    if(change.expectedVersion===0)await client.query('INSERT INTO request_catalog_publishers(employee_id,service_code) VALUES($1,$2)',[change.initialPublisherId,change.code]);
  }
  await client.query(`INSERT INTO service_catalog_revisions(service_code,form_version,proposal_id,structure_version,snapshot) VALUES($1,$2,$3,$4,$5)`,
    [change.code,version,proposalId,structureVersion,JSON.stringify(snapshot)]);
}

export async function catalogAdminRows(client:Client,actor:string){
  return (await client.query(`SELECT c.code,c.type,c.form_version AS "formVersion",c.published,c.name,c.description,c.group_id AS "groupId",
    c.visible_groups AS "visibleGroups",c.field_schema AS fields,c.sort_order AS "sortOrder",v.snapshot->'approval' AS approval,
    v.snapshot->'maxValidityDays' AS "maxValidityDays",
    (c.type='INC' OR EXISTS(SELECT 1 FROM request_catalog_publishers p WHERE p.service_code=c.code AND p.employee_id=$1)) AS "canPropose"
    FROM service_catalog c LEFT JOIN request_catalog_versions v ON v.service_code=c.code AND v.form_version=c.form_version
    ORDER BY c.sort_order,c.code LIMIT 501`,[actor])).rows;
}
