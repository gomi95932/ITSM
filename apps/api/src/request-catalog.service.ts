import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type PoolClient } from 'pg';
import { type Identity } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK } from './role-policy.js';

type Field = { key: string; label: string; required: boolean; options?: string[] };
type Step = { role: 'MANAGER' | 'SYSTEM_OWNER' | 'SECURITY_OWNER' | 'RESOURCE_OWNER' | 'LICENSE_OWNER' | 'DIRECTORY_OWNER'; approverId?: string };
type Publish = {
  contentClass: 'GENERAL'; expectedVersion: number; name: string; description: string;
  groupId: string; visibleGroups: string[]; fields: Field[];
  approval: { templateId: string; steps: Step[] }; maxValidityDays: number;
};
type Unpublish = { contentClass: 'GENERAL'; expectedVersion: number; reason: string };
type CatalogRow = { code: string; form_version: number; published: boolean; name: string; description: string;
  group_id: string; visible_groups: string[]; field_schema: Field[]; required_fields: string[] };
const codePattern = /^REQ-[A-Z0-9-]{1,36}$/;
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const fieldKeyPattern = /^[a-z][A-Za-z0-9_]{0,39}$/;
const roles = new Set<Step['role']>(['MANAGER','SYSTEM_OWNER','SECURITY_OWNER','RESOURCE_OWNER','LICENSE_OWNER','DIRECTORY_OWNER']);
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f]/.test(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const unique = (values: string[]) => new Set(values).size === values.length;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (plain(value)) return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function validateRequestCatalogPublish(body: unknown): Publish {
  if (!plain(body) || !only(body,['contentClass','expectedVersion','name','description','groupId','visibleGroups','fields','approval','maxValidityDays'])
    || body.contentClass !== 'GENERAL' || !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1
    || !text(body.name,100) || !text(body.description,500) || !text(body.groupId,100)
    || !Array.isArray(body.visibleGroups) || body.visibleGroups.length > 30
    || !body.visibleGroups.every(group => text(group,100)) || !unique(body.visibleGroups)
    || !Array.isArray(body.fields) || body.fields.length > 30 || !body.fields.every(field => plain(field)
      && only(field,['key','label','required','options']) && typeof field.key === 'string' && fieldKeyPattern.test(field.key)
      && text(field.label,80) && typeof field.required === 'boolean'
      && (field.options === undefined || (Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 30
        && field.options.every(option => text(option,100)) && unique(field.options))))
    || !unique(body.fields.map((field: Field) => field.key))
    || !plain(body.approval) || !only(body.approval,['templateId','steps']) || !text(body.approval.templateId,256)
    || !Number.isInteger(body.maxValidityDays) || (body.maxValidityDays as number) < 1 || (body.maxValidityDays as number) > 3650
    || !Array.isArray(body.approval.steps) || !body.approval.steps.length || body.approval.steps.length > 5
    || !body.approval.steps.every(step => plain(step) && only(step,['role','approverId']) && roles.has(step.role as Step['role'])
      && (step.role === 'MANAGER' ? step.approverId === undefined : text(step.approverId,200))))
    throw new BadRequestException({code:'INVALID_REQUEST_CATALOG'});
  return body as unknown as Publish;
}
function validateUnpublish(body: unknown): Unpublish {
  if (!plain(body) || !only(body,['contentClass','expectedVersion','reason']) || body.contentClass !== 'GENERAL'
    || !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1 || !text(body.reason,500))
    throw new BadRequestException({code:'INVALID_REQUEST_CATALOG'});
  return body as unknown as Unpublish;
}

@Injectable()
export class RequestCatalogService {
  constructor(private readonly db: Database, private readonly intake: IntakePolicyService) {}

  private async locked(client: PoolClient, actor: Identity, code: string): Promise<CatalogRow> {
    await client.query('SELECT pg_advisory_xact_lock($1)',[ROLE_AUTHORIZATION_LOCK]);
    if (!codePattern.test(code)) throw new NotFoundException();
    const service = await client.query<CatalogRow>('SELECT * FROM service_catalog WHERE code=$1 AND type=\'REQ\' FOR UPDATE',[code]);
    if (!service.rowCount) throw new NotFoundException();
    const appointment = await client.query(`SELECT p.employee_id FROM request_catalog_publishers p JOIN employees e ON e.id=p.employee_id
      WHERE p.employee_id=$1 AND p.service_code=$2 AND e.active FOR SHARE OF p,e`,[actor.id,code]);
    if (!appointment.rowCount) throw new ForbiddenException({code:'CATALOG_PUBLISHER_REQUIRED'});
    return service.rows[0];
  }

  private snapshot(row: CatalogRow): object {
    return {code:row.code,formVersion:row.form_version,published:row.published,name:row.name,description:row.description,
      groupId:row.group_id,visibleGroups:row.visible_groups,fields:row.field_schema,approval:null};
  }

  private async archiveCurrent(client: PoolClient, row: CatalogRow): Promise<void> {
    await client.query(`INSERT INTO request_catalog_versions(service_code,form_version,snapshot)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[row.code,row.form_version,JSON.stringify(this.snapshot(row))]);
  }

  private async currentSnapshot(client: PoolClient, row: CatalogRow): Promise<Record<string,unknown>> {
    await this.archiveCurrent(client,row);
    const revision = await client.query<{snapshot:Record<string,unknown>}>(
      'SELECT snapshot FROM request_catalog_versions WHERE service_code=$1 AND form_version=$2',[row.code,row.form_version]);
    return {...revision.rows[0].snapshot,published:row.published};
  }

  private async replay(client: PoolClient, actor: Identity, code: string, key: string, body: unknown, action: string) {
    if (!keyPattern.test(key)) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    const requestHash = createHash('sha256').update(canonical({action,body})).digest('hex');
    const existing = await client.query<{request_hash:string;response:object}>(`SELECT request_hash,response FROM request_catalog_audits
      WHERE service_code=$1 AND actor_id=$2 AND idempotency_key=$3`,[code,actor.id,key]);
    if (existing.rowCount) {
      if (existing.rows[0].request_hash !== requestHash) throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});
      return {requestHash,response:existing.rows[0].response};
    }
    return {requestHash,response:null};
  }

  async versions(actor: Identity, code: string) {
    return this.db.transaction(async client => {
      const current = await this.locked(client,actor,code);
      const versions = await client.query(`SELECT form_version AS "formVersion",snapshot,published_at AS "publishedAt",published_by AS "publishedBy"
        FROM request_catalog_versions WHERE service_code=$1 ORDER BY form_version DESC`,[code]);
      return {code,currentVersion:current.form_version,published:current.published,items:versions.rows};
    });
  }

  async publish(actor: Identity, code: string, body: unknown, key: string, requestId: string) {
    const input = validateRequestCatalogPublish(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'request-catalog');
    return this.db.transaction(async client => {
      const current = await this.locked(client,actor,code);
      const {requestHash,response} = await this.replay(client,actor,code,key,input,'PUBLISH');
      if (response) return response;
      if (input.expectedVersion !== current.form_version) throw new ConflictException({code:'FORM_VERSION_CONFLICT'});
      const route = await client.query(`SELECT p."groupId" FROM service_position_routes r
        JOIN support_positions p ON p.id=r."primaryPositionId" WHERE r."serviceCode"=$1 AND r.enabled`,[code]);
      if (route.rowCount && route.rows[0].groupId !== input.groupId)
        throw new ConflictException({code:'SERVICE_STRUCTURE_GROUP_MISMATCH'});
      const groups = [...input.visibleGroups,input.groupId];
      const foundGroups = await client.query('SELECT id FROM support_groups WHERE id=ANY($1::text[]) AND enabled',[groups]);
      if (foundGroups.rowCount !== new Set(groups).size) throw new BadRequestException({code:'CATALOG_GROUP_UNAVAILABLE'});
      const ids = input.approval.steps.flatMap(step => step.approverId ? [step.approverId] : []);
      if (!unique(ids)) throw new BadRequestException({code:'DUPLICATE_APPROVER'});
      if (ids.length) {
        const approvers = await client.query('SELECT id FROM employees WHERE id=ANY($1::text[]) AND active FOR SHARE',[ids]);
        if (approvers.rowCount !== ids.length) throw new BadRequestException({code:'APPROVER_UNAVAILABLE'});
      }
      const version = current.form_version + 1;
      const snapshot = {code,formVersion:version,published:true,name:input.name.trim(),description:input.description.trim(),
        groupId:input.groupId,visibleGroups:input.visibleGroups,fields:input.fields,
        approval:{templateId:input.approval.templateId.trim(),steps:input.approval.steps},maxValidityDays:input.maxValidityDays};
      const before = await this.currentSnapshot(client,current);
      await client.query(`INSERT INTO request_catalog_versions(service_code,form_version,snapshot,published_by) VALUES ($1,$2,$3,$4)`,
        [code,version,JSON.stringify(snapshot),actor.id]);
      await client.query(`UPDATE service_catalog SET form_version=$2,published=true,name=$3,description=$4,group_id=$5,
        visible_groups=$6,field_schema=$7,required_fields=$8 WHERE code=$1`,
        [code,version,snapshot.name,snapshot.description,input.groupId,JSON.stringify(input.visibleGroups),JSON.stringify(input.fields),
          JSON.stringify(input.fields.filter(field => field.required).map(field => field.key))]);
      const result = {code,formVersion:version,published:true,available:false};
      await client.query(`INSERT INTO request_catalog_audits(service_code,actor_id,action,idempotency_key,request_hash,before_value,after_value,response,request_id)
        VALUES ($1,$2,'PUBLISH',$3,$4,$5,$6,$7,$8)`,
        [code,actor.id,key,requestHash,JSON.stringify(before),JSON.stringify(snapshot),JSON.stringify(result),requestId]);
      return result;
    });
  }

  async unpublish(actor: Identity, code: string, body: unknown, key: string, requestId: string) {
    const input = validateUnpublish(body);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'request-catalog');
    return this.db.transaction(async client => {
      const current = await this.locked(client,actor,code);
      const {requestHash,response} = await this.replay(client,actor,code,key,input,'UNPUBLISH');
      if (response) return response;
      if (input.expectedVersion !== current.form_version || !current.published)
        throw new ConflictException({code:'CATALOG_VERSION_OR_STATE_CONFLICT'});
      const before = await this.currentSnapshot(client,current);
      await client.query('UPDATE service_catalog SET published=false WHERE code=$1',[code]);
      const result = {code,formVersion:current.form_version,published:false,available:false};
      await client.query(`INSERT INTO request_catalog_audits(service_code,actor_id,action,idempotency_key,request_hash,before_value,after_value,response,request_id)
        VALUES ($1,$2,'UNPUBLISH',$3,$4,$5,$6,$7,$8)`,
        [code,actor.id,key,requestHash,JSON.stringify(before),JSON.stringify({...before,published:false}),JSON.stringify(result),requestId]);
      return result;
    });
  }
}
