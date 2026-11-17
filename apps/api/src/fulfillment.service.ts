import { ConflictException,ForbiddenException,Injectable,NotFoundException,ServiceUnavailableException,UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FulfillmentAction,FulfillmentDetail,FulfillmentItem,FulfillmentList,RequestDeliveryItem,RequestDeliveryList,RequestDeliveryOperation,RequestDeliveryReceipt } from '@itsm/contracts';
import type { Identity } from './auth.service.js';
import { Database } from './database.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { ROLE_AUTHORIZATION_LOCK } from './role-policy.js';
import { fulfillmentAction,fulfillmentFilter,fulfillmentUuid,requestDeliveryAction } from './fulfillment-policy.js';

const unreviewed="f.state IN ('DELIVERED','REVOKE_DUE') AND f.reviewed_at IS NULL";
const due="(f.state='REVOKE_DUE' OR (f.state='DELIVERED' AND f.access_expires_at<=clock_timestamp()))";
const from=`FROM request_fulfillments f JOIN tickets t ON t.id=f.ticket_id
  JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled
  JOIN employees delivery ON delivery.id=f.assignee_id JOIN employees requester ON requester.id=t.requester_id
  LEFT JOIN employees reviewer ON reviewer.id=f.reviewed_by`;
const columns=`f.id,t.id AS "ticketId",t.number,t.subject,COALESCE(t.catalog_snapshot->>'name',c.name,t.service_code) AS "serviceName",
  t.owner_group_id AS "groupId",g.name AS "groupName",delivery.display_name AS "assigneeName",requester.display_name AS "requesterName",
  f.state,f.version,NULL::text AS "reasonCode",f.delivered_at AS "deliveredAt",f.access_expires_at AS "accessExpiresAt",
  f.reviewed_at AS "reviewedAt",reviewer.display_name AS "reviewerName",f.revoked_at AS "revokedAt",
  ((${unreviewed}) AND request_fulfillment_operator_eligible(f.id,$1,'REVIEW')) AS "canReview",
  (f.state IN ('DELIVERED','REVOKE_DUE') AND request_fulfillment_operator_eligible(f.id,$1,'REVOKE')) AS "canRevoke"`;
const catalogJoin='LEFT JOIN service_catalog c ON c.code=t.service_code';
const receiptColumns=`id,operation,state,result,error_code AS "errorCode",created_at AS "createdAt",completed_at AS "completedAt"`;
const deliveryFrom=`FROM request_approvals a JOIN tickets t ON t.id=a.ticket_id
  JOIN support_groups g ON g.id=t.owner_group_id AND g.enabled JOIN employees requester ON requester.id=t.requester_id
  LEFT JOIN service_catalog c ON c.code=t.service_code LEFT JOIN request_fulfillments f ON f.approval_id=a.id
  LEFT JOIN employees delivery ON delivery.id=f.assignee_id
  LEFT JOIN LATERAL(SELECT ${receiptColumns} FROM request_delivery_commands WHERE approval_id=a.id AND actor_id=$1
    ORDER BY created_at DESC,id DESC LIMIT 1) command ON true`;

@Injectable()
export class FulfillmentService {
  constructor(private readonly db:Database,private readonly intake:IntakePolicyService){}

  private async groups(client:PoolClient,actor:string){
    await client.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor])).rowCount)
      throw new UnauthorizedException({code:'EMPLOYEE_DISABLED'});
    const result=await client.query<{id:string;name:string}>(`SELECT g.id,g.name FROM support_groups g
      JOIN group_memberships m ON m.group_id=g.id WHERE m.employee_id=$1 AND g.enabled ORDER BY g.name,g.id`,[actor]);
    if(!result.rowCount)throw new NotFoundException();
    return result.rows;
  }

  async deliveryList(actor:Identity,query:{group?:unknown;page?:unknown}):Promise<RequestDeliveryList>{
    const filter=fulfillmentFilter({...query,queue:'ALL'}),enabled=process.env.ENABLE_MANUAL_REQUEST_DELIVERY==='true';
    return this.db.transaction(async client=>{
      const groups=await this.groups(client,actor.id),ids=groups.map(g=>g.id);
      if(filter.group&&!ids.includes(filter.group))throw new NotFoundException();
      const scope=filter.group?[filter.group]:ids;
      const where=`t.owner_group_id=ANY($2::text[]) AND (f.id IS NULL OR f.state IN ('READY','BLOCKED')
        OR command.state='PENDING' OR command."completedAt">clock_timestamp()-interval '1 day')
        AND (a.state='APPROVED' OR f.id IS NOT NULL OR command.id IS NOT NULL)`;
      const total=(await client.query(`SELECT count(*)::int AS total ${deliveryFrom} WHERE ${where}`,[actor.id,scope])).rows[0].total;
      const items=(await client.query<RequestDeliveryItem>(`SELECT a.id AS "approvalId",t.id AS "ticketId",t.number,t.subject,
        COALESCE(t.catalog_snapshot->>'name',c.name,t.service_code) AS "serviceName",g.id AS "groupId",g.name AS "groupName",
        requester.display_name AS "requesterName",a.state AS "approvalState",a.expires_at AS deadline,
        f.id AS "taskId",f.state AS "taskState",COALESCE(f.version,0) AS version,delivery.display_name AS "assigneeName",
        ($4 AND a.state='APPROVED' AND a.last_verified_at IS NOT NULL AND a.lease_token IS NULL AND a.expires_at>clock_timestamp()
          AND t.status='WAITING_APPROVAL' AND request_delivery_operator_eligible(a.id,$1) AND f.id IS NULL
          AND NOT EXISTS(SELECT 1 FROM request_delivery_commands pending WHERE pending.approval_id=a.id AND pending.state='PENDING')) AS "canPrepare",
        COALESCE(($4 AND a.state='APPROVED' AND a.last_verified_at IS NOT NULL AND a.lease_token IS NULL AND a.expires_at>clock_timestamp()
          AND t.status='WAITING_APPROVAL' AND request_delivery_operator_eligible(a.id,$1) AND f.state='READY' AND f.assignee_id=$1
          AND f.ready_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM request_delivery_commands pending WHERE pending.approval_id=a.id AND pending.state='PENDING')),false) AS "canDeliver",
        CASE WHEN command.id IS NULL THEN NULL ELSE row_to_json(command) END AS command
        ${deliveryFrom} WHERE ${where} ORDER BY a.created_at DESC,a.id LIMIT 20 OFFSET $3`,[actor.id,scope,(filter.page-1)*20,enabled])).rows.map(row=>({...row,
          command:row.command?{...row.command,createdAt:new Date(row.command.createdAt).toISOString(),
            completedAt:row.command.completedAt?new Date(row.command.completedAt).toISOString():null}:null}));
      return {enabled,items,groups,total,page:filter.page,size:20};
    });
  }

  async enqueueDelivery(actor:Identity,id:string,operation:RequestDeliveryOperation,body:unknown,key:unknown):Promise<RequestDeliveryReceipt>{
    if(!fulfillmentUuid.test(id))throw new NotFoundException();
    if(process.env.ENABLE_MANUAL_REQUEST_DELIVERY!=='true')throw new ServiceUnavailableException({code:'REQUEST_DELIVERY_DISABLED'});
    const input=requestDeliveryAction(body,key,operation);
    if(input.reference)await this.intake.requireGeneral(actor.id,{reference:input.reference,contentClass:input.contentClass},'fulfillment');
    const hash=createHash('sha256').update(JSON.stringify({id:id.toLowerCase(),operation,...input})).digest('hex');
    return this.db.transaction(async client=>{
      const groups=await this.groups(client,actor.id);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`request-delivery:${actor.id}:${input.key}`]);
      const approval=(await client.query(`SELECT a.*,t.owner_group_id FROM request_approvals a JOIN tickets t ON t.id=a.ticket_id
        WHERE a.id=$1 FOR UPDATE OF a`,[id])).rows[0];
      if(!approval||!groups.some(g=>g.id===approval.owner_group_id))throw new NotFoundException();
      const task=(await client.query('SELECT * FROM request_fulfillments WHERE approval_id=$1 FOR UPDATE',[id])).rows[0];
      const ticket=(await client.query('SELECT * FROM tickets WHERE id=$1 FOR SHARE',[approval.ticket_id])).rows[0];
      if(!groups.some(g=>g.id===ticket.owner_group_id))throw new NotFoundException();
      if(!(await client.query('SELECT request_delivery_operator_eligible($1,$2) AS allowed',[id,actor.id])).rows[0].allowed)
        throw new ForbiddenException({code:'FULFILLMENT_OPERATOR_DENIED'});
      const prior=(await client.query(`SELECT ${receiptColumns},request_hash FROM request_delivery_commands WHERE actor_id=$1 AND request_key=$2`,[actor.id,input.key])).rows[0];
      if(prior){
        if(prior.request_hash!==hash)throw new ConflictException({code:'FULFILLMENT_KEY_CONFLICT'});
        const {request_hash:_,...receipt}=prior;return receipt;
      }
      if(ticket.status!=='WAITING_APPROVAL'||approval.state!=='APPROVED'||!approval.last_verified_at||approval.lease_token
        ||!(await client.query('SELECT expires_at>clock_timestamp() AS valid FROM request_approvals WHERE id=$1',[id])).rows[0].valid)
        throw new ConflictException({code:'FULFILLMENT_APPROVAL_UNAVAILABLE'});
      if(operation==='PREPARE'&&task)throw new ConflictException({code:'FULFILLMENT_ALREADY_EXISTS'});
      if(operation==='DELIVER'&&(!task||task.state!=='READY'||task.assignee_id!==actor.id))
        throw new ConflictException({code:'FULFILLMENT_NOT_READY'});
      if(operation==='DELIVER'&&!(await client.query('SELECT ready_until>clock_timestamp() AS valid FROM request_fulfillments WHERE id=$1',[task.id])).rows[0].valid)
        throw new ConflictException({code:'FULFILLMENT_NOT_READY'});
      if((task?.version??0)!==input.expectedVersion)throw new ConflictException({code:'FULFILLMENT_VERSION_CONFLICT'});
      if((await client.query("SELECT 1 FROM request_delivery_commands WHERE approval_id=$1 AND state='PENDING'",[id])).rowCount)
        throw new ConflictException({code:'REQUEST_DELIVERY_PENDING'});
      return (await client.query<RequestDeliveryReceipt>(`INSERT INTO request_delivery_commands(approval_id,actor_id,request_key,operation,
        expected_version,evidence_reference,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${receiptColumns}`,
        [id,actor.id,input.key,operation,input.expectedVersion,input.reference,hash])).rows[0];
    });
  }

  async list(actor:Identity,query:{queue?:unknown;group?:unknown;page?:unknown}):Promise<FulfillmentList>{
    const filter=fulfillmentFilter(query);
    return this.db.transaction(async client=>{
      const groups=await this.groups(client,actor.id),ids=groups.map(g=>g.id);
      if(filter.group&&!ids.includes(filter.group))throw new NotFoundException();
      const scope=filter.group?[filter.group]:ids;
      const counts=(await client.query<{unreviewed:number;revokeDue:number;all:number}>(`SELECT
        count(*) FILTER(WHERE ${unreviewed})::int AS unreviewed,count(*) FILTER(WHERE ${due})::int AS "revokeDue",
        count(*)::int AS "all" ${from} WHERE t.owner_group_id=ANY($1::text[])`,[scope])).rows[0];
      const where=filter.queue==='UNREVIEWED'?unreviewed:filter.queue==='REVOKE_DUE'?due:'true';
      const items=(await client.query<FulfillmentItem>(`SELECT ${columns} ${from} ${catalogJoin}
        WHERE t.owner_group_id=ANY($2::text[]) AND (${where}) ORDER BY f.created_at DESC,f.id
        LIMIT 20 OFFSET $3`,[actor.id,scope,(filter.page-1)*20])).rows;
      return {items,groups,counts,page:filter.page,size:filter.size,total:filter.queue==='UNREVIEWED'?counts.unreviewed:filter.queue==='REVOKE_DUE'?counts.revokeDue:counts.all};
    });
  }

  async detail(actor:Identity,id:string):Promise<FulfillmentDetail>{
    if(!fulfillmentUuid.test(id))throw new NotFoundException();
    return this.db.transaction(async client=>{
      const groups=await this.groups(client,actor.id);
      const result=await client.query<FulfillmentItem>(`SELECT ${columns} ${from} ${catalogJoin}
        WHERE f.id=$3 AND t.owner_group_id=ANY($2::text[])`,[actor.id,groups.map(g=>g.id),id]);
      if(!result.rowCount)throw new NotFoundException();
      // Only an external record reference is exposed, never provider bindings or approval snapshots.
      const history=await client.query<FulfillmentDetail['events'][number]>(`SELECT e.id,e.action,e.from_state AS "fromState",e.to_state AS "toState",
        p.display_name AS "actorName",e.evidence_reference AS reference,e.created_at AS "createdAt"
        FROM request_fulfillment_events e LEFT JOIN employees p ON p.id=e.actor_id
        WHERE e.fulfillment_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 101`,[id]);
      return {...result.rows[0],events:history.rows.slice(0,100).reverse(),eventsHasMore:history.rows.length>100};
    });
  }

  async action(actor:Identity,id:string,operation:FulfillmentAction,body:unknown,key:unknown){
    if(!fulfillmentUuid.test(id))throw new NotFoundException();
    const input=fulfillmentAction(body,key);
    await this.intake.requireGeneral(actor.id,{reference:input.reference,contentClass:input.contentClass},'fulfillment');
    const hash=createHash('sha256').update(JSON.stringify({id:id.toLowerCase(),operation,...input})).digest('hex');
    try{return await this.db.transaction(async client=>{
      const groups=await this.groups(client,actor.id);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fulfillment:${actor.id}:${input.key}`]);
      // Match the worker's approval -> fulfillment -> ticket lock order.
      const approval=await client.query(`SELECT a.id FROM request_approvals a
        WHERE a.id=(SELECT approval_id FROM request_fulfillments WHERE id=$1) FOR UPDATE`,[id]);
      if(!approval.rowCount)throw new NotFoundException();
      const task=(await client.query('SELECT ticket_id FROM request_fulfillments WHERE id=$1 FOR UPDATE',[id])).rows[0];
      const ticket=await client.query('SELECT owner_group_id FROM tickets WHERE id=$1 FOR SHARE',[task.ticket_id]);
      if(!groups.some(g=>g.id===ticket.rows[0].owner_group_id))throw new NotFoundException();
      const eligible=await client.query('SELECT request_fulfillment_operator_eligible($1,$2,$3) AS allowed',[id,actor.id,operation]);
      if(!eligible.rows[0].allowed)throw new ForbiddenException({code:'FULFILLMENT_OPERATOR_DENIED'});
      const prior=await client.query('SELECT request_hash,result FROM request_fulfillment_commands WHERE actor_id=$1 AND request_key=$2',[actor.id,input.key]);
      if(prior.rowCount){
        if(prior.rows[0].request_hash!==hash)throw new ConflictException({code:'FULFILLMENT_KEY_CONFLICT'});
        return prior.rows[0].result;
      }
      const changed=await client.query('SELECT perform_request_fulfillment_action($1,$2,$3,$4,$5) AS version',
        [approval.rows[0].id,actor.id,operation,input.reference,input.expectedVersion]);
      const result={id:id.toLowerCase(),action:operation,version:changed.rows[0].version as number};
      await client.query(`INSERT INTO request_fulfillment_commands(actor_id,request_key,fulfillment_id,action,request_hash,result)
        VALUES($1,$2,$3,$4,$5,$6)`,[actor.id,input.key,id,operation,hash,JSON.stringify(result)]);
      return result;
    });}catch(error){
      const message=error instanceof Error?error.message:'';
      if(['APPROVAL_NOT_FOUND','FULFILLMENT_NOT_FOUND'].includes(message))throw new NotFoundException();
      if(message==='FULFILLMENT_OPERATOR_DENIED')throw new ForbiddenException({code:message});
      if(['FULFILLMENT_VERSION_CONFLICT','FULFILLMENT_REVIEW_UNAVAILABLE','FULFILLMENT_NOT_DELIVERED','FULFILLMENT_EVIDENCE_REUSED'].includes(message))
        throw new ConflictException({code:message});
      throw error;
    }
  }
}
