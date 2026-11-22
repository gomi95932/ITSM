import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { type PoolClient } from 'pg';
import { type Identity } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';

type Article = { id: string; owner_group_id: string; author_id: string; source_ticket_id: string | null;
  status: string; draft_version: number; published_version: number | null; review_version: number | null;
  reviewed_by: string | null; title: string; body: string; audience: string; review_due_at: Date };
type Draft = { contentClass: 'GENERAL'; groupId?: string; sourceTicketId?: string; title: string; body: string;
  audience: 'EMPLOYEE' | 'SUPPORT_GROUP'; reviewDueAt: string; expectedVersion?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);

function draft(body: unknown, create: boolean): Draft {
  const keys = ['contentClass','title','body','audience','reviewDueAt',...(create ? ['groupId','sourceTicketId'] : ['expectedVersion'])];
  if (!plain(body) || !only(body,keys) || body.contentClass !== 'GENERAL' || !text(body.title,160)
    || !text(body.body,12000) || !['EMPLOYEE','SUPPORT_GROUP'].includes(String(body.audience))
    || typeof body.reviewDueAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(body.reviewDueAt)
    || !Number.isFinite(Date.parse(body.reviewDueAt)) || Date.parse(body.reviewDueAt) < Date.now() + 86400000
    || Date.parse(body.reviewDueAt) > Date.now() + 366 * 86400000
    || (create ? !text(body.groupId,100) || (body.sourceTicketId !== undefined && !uuid.test(String(body.sourceTicketId)))
      : !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1))
    throw new BadRequestException({code:'INVALID_KNOWLEDGE_DRAFT'});
  return body as unknown as Draft;
}

@Injectable()
export class KnowledgeService {
  constructor(private readonly db: Database, private readonly intake: IntakePolicyService) {}

  private async appointed(client: PoolClient, actor: Identity, group: string, role: 'editors'|'reviewers') {
    if (!actor.groups.includes(group)) throw new NotFoundException();
    const result = await client.query(`SELECT 1 FROM knowledge_${role} k
      JOIN group_memberships m ON m.employee_id=k.employee_id AND m.group_id=k.group_id JOIN employees e ON e.id=m.employee_id
      WHERE k.employee_id=$1 AND k.group_id=$2 AND e.active FOR SHARE OF k,m,e`,[actor.id,group]);
    if (!result.rowCount) throw new ForbiddenException({code:'KNOWLEDGE_ROLE_REQUIRED'});
  }
  private async locked(client: PoolClient, id: string): Promise<Article> {
    if (!uuid.test(id)) throw new NotFoundException();
    const result = await client.query<Article>('SELECT * FROM knowledge_articles WHERE id=$1 FOR UPDATE',[id]);
    if (!result.rowCount) throw new NotFoundException();
    return result.rows[0];
  }
  private async replay(client: PoolClient, actor: Identity, id: string | null, action: string, input: unknown, key: string) {
    if (!keyPattern.test(key)) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    const hash = createHash('sha256').update(JSON.stringify({id,action,input})).digest('hex');
    const result = await client.query<{request_hash:string;response:object}>(
      'SELECT request_hash,response FROM knowledge_audits WHERE actor_id=$1 AND idempotency_key=$2',[actor.id,key]);
    if (result.rowCount && result.rows[0].request_hash !== hash) throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});
    return {hash,response:result.rows[0]?.response};
  }
  private async audit(client: PoolClient, article: Article, actor: Identity, action: string, key: string,
    hash: string, before: object | null, response: object, requestId: string) {
    await client.query(`INSERT INTO knowledge_audits(article_id,actor_id,action,idempotency_key,request_hash,before_value,after_value,response,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[article.id,actor.id,action,key,hash,JSON.stringify(before),
      JSON.stringify({status:article.status,draftVersion:article.draft_version,publishedVersion:article.published_version}),
      JSON.stringify(response),requestId]);
  }
  private summary(row: Article) {
    return {id:row.id,status:row.status,draftVersion:row.draft_version,publishedVersion:row.published_version,
      groupId:row.owner_group_id,sourceTicketId:row.source_ticket_id,audience:row.audience,
      title:row.title,body:row.body,reviewDueAt:row.review_due_at,reviewVersion:row.review_version,
      authorId:row.author_id,reviewedBy:row.reviewed_by};
  }

  async roles(actor: Identity) {
    const result=await this.db.pool.query<{group_id:string;editor:boolean;reviewer:boolean}>(`
      SELECT m.group_id, EXISTS(SELECT 1 FROM knowledge_editors e WHERE e.employee_id=m.employee_id AND e.group_id=m.group_id) AS editor,
        EXISTS(SELECT 1 FROM knowledge_reviewers r WHERE r.employee_id=m.employee_id AND r.group_id=m.group_id) AS reviewer
      FROM group_memberships m WHERE m.employee_id=$1 ORDER BY m.group_id`,[actor.id]);
    return {groups:result.rows.filter(row=>row.editor||row.reviewer).map(row=>({groupId:row.group_id,editor:row.editor,reviewer:row.reviewer}))};
  }

  async create(actor: Identity, body: unknown, key: string, requestId: string) {
    const input=draft(body,true);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'knowledge');
    return this.db.transaction(async client => {
      await this.appointed(client,actor,input.groupId!,'editors');
      const {hash,response}=await this.replay(client,actor,null,'CREATE',input,key);
      if (response) return response;
      if (input.sourceTicketId) {
        const source=await client.query(`SELECT 1 FROM tickets WHERE id=$1 AND owner_group_id=$2 AND service_type='INC' AND status='CLOSED'
          AND staff_site_access(service_routing_snapshot,$3,owner_group_id)`,[input.sourceTicketId,input.groupId,actor.id]);
        if (!source.rowCount) throw new BadRequestException({code:'KNOWLEDGE_SOURCE_UNAVAILABLE'});
      }
      const result=await client.query<Article>(`INSERT INTO knowledge_articles(owner_group_id,source_ticket_id,author_id,audience,title,body,review_due_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[input.groupId,input.sourceTicketId ?? null,actor.id,
        input.audience,input.title.trim(),input.body.trim(),input.reviewDueAt]);
      const row=result.rows[0], output=this.summary(row);
      await this.audit(client,row,actor,'CREATE',key,hash,null,output,requestId);
      return output;
    });
  }

  async revise(actor: Identity, id: string, body: unknown, key: string, requestId: string) {
    const input=draft(body,false);
    await this.intake.requireGeneral(actor.id,input as unknown as Record<string,unknown>,'knowledge');
    return this.db.transaction(async client => {
      const row=await this.locked(client,id);
      await this.appointed(client,actor,row.owner_group_id,'editors');
      if(!(await client.query('SELECT 1 WHERE knowledge_site_access($1,$2)',[id,actor.id])).rowCount)throw new NotFoundException();
      if (row.author_id !== actor.id) throw new ForbiddenException({code:'KNOWLEDGE_AUTHOR_REQUIRED'});
      const {hash,response}=await this.replay(client,actor,id,'REVISE',input,key);
      if (response) return response;
      if (!['DRAFT','PUBLISHED'].includes(row.status) || row.draft_version !== input.expectedVersion)
        throw new ConflictException({code:'KNOWLEDGE_VERSION_OR_STATE_CONFLICT'});
      const before={status:row.status,draftVersion:row.draft_version,publishedVersion:row.published_version};
      const result=await client.query<Article>(`UPDATE knowledge_articles SET status='DRAFT',draft_version=draft_version+1,
        review_version=NULL,reviewed_by=NULL,title=$2,body=$3,audience=$4,review_due_at=$5,updated_at=now()
        WHERE id=$1 RETURNING *`,[id,input.title.trim(),input.body.trim(),input.audience,input.reviewDueAt]);
      const updated=result.rows[0],output=this.summary(updated);
      await this.audit(client,updated,actor,'REVISE',key,hash,before,output,requestId);
      return output;
    });
  }

  async transition(actor: Identity, id: string, action: 'SUBMIT'|'APPROVE'|'REJECT'|'PUBLISH'|'ARCHIVE',
    body: unknown, key: string, requestId: string) {
    if (!plain(body) || !only(body,['expectedVersion']) || !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number)<1)
      throw new BadRequestException({code:'INVALID_KNOWLEDGE_ACTION'});
    return this.db.transaction(async client => {
      const row=await this.locked(client,id);
      await this.appointed(client,actor,row.owner_group_id,action==='APPROVE'||action==='REJECT'?'reviewers':'editors');
      if(!(await client.query('SELECT 1 WHERE knowledge_site_access($1,$2)',[id,actor.id])).rowCount)throw new NotFoundException();
      const {hash,response}=await this.replay(client,actor,id,action,body,key);
      if (response) return response;
      if (row.draft_version !== body.expectedVersion) throw new ConflictException({code:'KNOWLEDGE_VERSION_OR_STATE_CONFLICT'});
      const before={status:row.status,draftVersion:row.draft_version,publishedVersion:row.published_version};
      let status:string,reviewVersion=row.review_version,reviewedBy=row.reviewed_by;
      if (action==='SUBMIT' && row.status==='DRAFT' && row.author_id===actor.id) status='IN_REVIEW';
      else if (action==='APPROVE' && row.status==='IN_REVIEW' && row.author_id!==actor.id) {
        status='APPROVED';reviewVersion=row.draft_version;reviewedBy=actor.id;
      } else if (action==='REJECT' && row.status==='IN_REVIEW' && row.author_id!==actor.id) {
        status='DRAFT';reviewVersion=null;reviewedBy=null;
      } else if (action==='PUBLISH' && row.status==='APPROVED' && row.review_version===row.draft_version
        && row.reviewed_by!==actor.id && row.review_due_at.getTime()>Date.now()) status='PUBLISHED';
      else if (action==='ARCHIVE' && row.status!=='ARCHIVED' && row.published_version!==null) status='ARCHIVED';
      else throw new ConflictException({code:'KNOWLEDGE_VERSION_OR_STATE_CONFLICT'});
      const result=await client.query<Article>(`UPDATE knowledge_articles SET status=$2,review_version=$3,reviewed_by=$4,
        published_version=CASE WHEN $5='PUBLISH' THEN draft_version ELSE published_version END,updated_at=now()
        WHERE id=$1 RETURNING *`,[id,status,reviewVersion,reviewedBy,action]);
      const updated=result.rows[0];
      if (action==='PUBLISH') await client.query(`INSERT INTO knowledge_versions(article_id,version,title,body,audience,review_due_at,approved_by,published_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,row.draft_version,row.title,row.body,row.audience,row.review_due_at,row.reviewed_by,actor.id]);
      const output=this.summary(updated);
      await this.audit(client,updated,actor,action,key,hash,before,output,requestId);
      return output;
    });
  }

  async list(actor: Identity, scope?: string, search?: string) {
    if (scope && scope!=='managed') throw new BadRequestException({code:'INVALID_KNOWLEDGE_SCOPE'});
    if (search && (search.length>100 || /[\x00-\x1f]/.test(search))) throw new BadRequestException({code:'INVALID_KNOWLEDGE_SEARCH'});
    const pattern=`%${(search ?? '').replace(/[!%_]/g,'!$&')}%`;
    if (scope==='managed') {
      const result=await this.db.pool.query(`SELECT a.id,a.status,a.draft_version AS "draftVersion",a.published_version AS "publishedVersion",
        a.title,a.audience,a.review_due_at AS "reviewDueAt" FROM knowledge_articles a
        WHERE a.owner_group_id=ANY($1::text[]) AND knowledge_site_access(a.id,$2) AND (EXISTS(SELECT 1 FROM knowledge_editors e WHERE e.employee_id=$2 AND e.group_id=a.owner_group_id)
          OR EXISTS(SELECT 1 FROM knowledge_reviewers r WHERE r.employee_id=$2 AND r.group_id=a.owner_group_id))
        AND a.title ILIKE $3 ESCAPE '!' ORDER BY a.updated_at DESC LIMIT 50`,[actor.groups,actor.id,pattern]);
      return {items:result.rows};
    }
    const result=await this.db.pool.query(`SELECT v.article_id AS id,v.version,v.title,v.audience,v.published_at AS "publishedAt"
      FROM knowledge_articles a JOIN knowledge_versions v ON v.article_id=a.id AND v.version=a.published_version
      WHERE a.status<>'ARCHIVED' AND v.review_due_at>now() AND (v.audience='EMPLOYEE' OR a.owner_group_id=ANY($1::text[]))
        AND knowledge_site_access(a.id,$3) AND (v.title ILIKE $2 ESCAPE '!' OR v.body ILIKE $2 ESCAPE '!') ORDER BY v.published_at DESC LIMIT 50`,[actor.groups,pattern,actor.id]);
    return {items:result.rows};
  }

  async feedback(actor: Identity, id: string, body: unknown, key: string, requestId: string) {
    if (!plain(body) || !only(body,['version','helpful']) || !Number.isInteger(body.version)
      || (body.version as number)<1 || typeof body.helpful!=='boolean')
      throw new BadRequestException({code:'INVALID_KNOWLEDGE_FEEDBACK'});
    return this.db.transaction(async client => {
      const row=await this.locked(client,id);
      const employee=await client.query('SELECT 1 FROM employees WHERE id=$1 AND active FOR SHARE',[actor.id]);
      if (!employee.rowCount) throw new ForbiddenException({code:'EMPLOYEE_DISABLED'});
      if(!(await client.query('SELECT 1 WHERE knowledge_site_access($1,$2)',[id,actor.id])).rowCount)throw new NotFoundException();
      const publication=await client.query<{audience:string;available:boolean}>(`SELECT audience,review_due_at>clock_timestamp() AS available
        FROM knowledge_versions WHERE article_id=$1 AND version=$2`,[id,row.published_version]);
      if (row.status==='ARCHIVED' || !publication.rows[0]?.available) throw new NotFoundException();
      if (publication.rows[0].audience==='SUPPORT_GROUP') {
        const membership=await client.query(`SELECT 1 FROM group_memberships WHERE employee_id=$1 AND group_id=$2 FOR SHARE`,
          [actor.id,row.owner_group_id]);
        if (!membership.rowCount) throw new NotFoundException();
      }
      const {hash,response}=await this.replay(client,actor,id,'FEEDBACK',body,key);
      if (response) return response;
      if (body.version!==row.published_version) throw new ConflictException({code:'KNOWLEDGE_VERSION_OR_STATE_CONFLICT'});
      const existing=await client.query('SELECT 1 FROM knowledge_feedback WHERE article_id=$1 AND version=$2 AND employee_id=$3',
        [id,body.version,actor.id]);
      if (existing.rowCount) throw new ConflictException({code:'KNOWLEDGE_FEEDBACK_ALREADY_SUBMITTED'});
      const result=await client.query<{created_at:Date}>(`INSERT INTO knowledge_feedback(article_id,version,employee_id,helpful)
        VALUES ($1,$2,$3,$4) RETURNING created_at`,[id,body.version,actor.id,body.helpful]);
      const output={version:body.version,helpful:body.helpful,submittedAt:result.rows[0].created_at};
      await this.audit(client,row,actor,'FEEDBACK',key,hash,null,output,requestId);
      return output;
    }).catch((error:unknown) => {
      if (plain(error) && error.code==='23505' && error.constraint==='knowledge_audits_actor_id_idempotency_key_key')
        throw new ConflictException({code:'IDEMPOTENCY_KEY_REUSED'});
      throw error;
    });
  }

  async get(actor: Identity, id: string, managed=false) {
    if (!uuid.test(id)) throw new NotFoundException();
    if (managed) {
      const result=await this.db.pool.query<Article>(`SELECT a.* FROM knowledge_articles a WHERE a.id=$1 AND a.owner_group_id=ANY($2::text[]) AND knowledge_site_access(a.id,$3)
        AND (EXISTS(SELECT 1 FROM knowledge_editors e WHERE e.employee_id=$3 AND e.group_id=a.owner_group_id)
          OR EXISTS(SELECT 1 FROM knowledge_reviewers r WHERE r.employee_id=$3 AND r.group_id=a.owner_group_id))`,[id,actor.groups,actor.id]);
      if (!result.rowCount) throw new NotFoundException();
      const row=result.rows[0];
      const summary=await this.db.pool.query(`SELECT count(*)::integer AS total,
        count(*) FILTER (WHERE helpful)::integer AS helpful,count(*) FILTER (WHERE NOT helpful)::integer AS "notHelpful"
        FROM knowledge_feedback WHERE article_id=$1 AND version=$2`,[id,row.published_version]);
      return {...this.summary(row),feedbackSummary:row.published_version===null?null:{version:row.published_version,...summary.rows[0]}};
    }
    const result=await this.db.pool.query(`SELECT v.version,v.title,v.body,v.audience,v.published_at AS "publishedAt",v.review_due_at AS "reviewDueAt",
      CASE WHEN f.employee_id IS NULL THEN NULL ELSE jsonb_build_object('version',f.version,'helpful',f.helpful,'submittedAt',f.created_at) END AS feedback
      FROM knowledge_articles a JOIN knowledge_versions v ON v.article_id=a.id AND v.version=a.published_version
      LEFT JOIN knowledge_feedback f ON f.article_id=v.article_id AND f.version=v.version AND f.employee_id=$3
      WHERE a.id=$1 AND a.status<>'ARCHIVED' AND v.review_due_at>now() AND knowledge_site_access(a.id,$3)
        AND (v.audience='EMPLOYEE' OR a.owner_group_id=ANY($2::text[]))`,[id,actor.groups,actor.id]);
    if (!result.rowCount) throw new NotFoundException();
    return {id,...result.rows[0]};
  }
}
