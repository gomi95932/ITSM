import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
type H = Record<string,string | undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

@Controller('delegations')
export class DelegationsController {
  constructor(private readonly db:Database,private readonly identity:AuthService) {}
  @Get('candidates') async candidates(@Headers() h:H) {
    const actor=await this.identity.identity(auth(h));
    return {items:(await this.db.pool.query(`SELECT e.id,e.display_name AS name FROM employees e WHERE e.active AND e.id<>$1
      AND EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=e.id) ORDER BY e.display_name,e.id LIMIT 200`,[actor.id])).rows};
  }
  @Get() async list(@Headers() h:H) {
    const actor=await this.identity.identity(auth(h));
    const rows=await this.db.pool.query(`SELECT d.id,d.requester_id AS "requesterId",r.display_name AS "requesterName",
      d.delegate_id AS "delegateId",a.display_name AS "delegateName",d.expires_at AS "expiresAt",d.revoked_at AS "revokedAt",
      (d.revoked_at IS NULL AND d.expires_at>now() AND r.active AND a.active
        AND EXISTS(SELECT 1 FROM group_memberships m WHERE m.employee_id=a.id)) AS active
      FROM ticket_delegations d JOIN employees r ON r.id=d.requester_id JOIN employees a ON a.id=d.delegate_id
      WHERE d.requester_id=$1 OR d.delegate_id=$1 ORDER BY d.created_at DESC,d.id LIMIT 200`,[actor.id]);
    return {items:rows.rows};
  }
  @Post() async grant(@Headers() h:H,@Body() body:unknown) {
    const actor=await this.identity.identity(auth(h),true),b=body as Record<string,unknown>;
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['id','delegateId','expiresAt','consent'].includes(k))
      ||typeof b.id!=='string'||!uuid.test(b.id)||typeof b.delegateId!=='string'||!b.delegateId||b.delegateId.length>200
      ||typeof b.expiresAt!=='string'||!Number.isFinite(Date.parse(b.expiresAt))||b.consent!==true||b.delegateId===actor.id)
      throw new BadRequestException({code:'INVALID_DELEGATION'});
    const expires=new Date(b.expiresAt);
    return this.db.transaction(async client=>{
      const active=await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor.id]);
      if(!active.rowCount)throw new UnauthorizedException();
      const agent=await client.query(`SELECT e.id FROM employees e JOIN group_memberships m ON m.employee_id=e.id
        WHERE e.id=$1 AND e.active FOR SHARE OF e,m`,[b.delegateId]);
      if(!agent.rowCount)throw new BadRequestException({code:'DELEGATE_UNAVAILABLE'});
      const inserted=await client.query(`INSERT INTO ticket_delegations(id,requester_id,delegate_id,expires_at)
        SELECT $1,$2,$3,$4 WHERE $4::timestamptz>now() AND $4::timestamptz<=now()+interval '7 days'
        ON CONFLICT DO NOTHING RETURNING id`,[b.id,actor.id,b.delegateId,expires]);
      const existing=await client.query('SELECT *,expires_at>now() AS valid FROM ticket_delegations WHERE id=$1 FOR SHARE',[b.id]);
      const row=existing.rows[0];
      if(!row||row.requester_id!==actor.id||row.delegate_id!==b.delegateId||row.expires_at.getTime()!==expires.getTime()||row.revoked_at||!row.valid)
        throw new ConflictException({code:'DELEGATION_CONFLICT_OR_EXPIRY'});
      if(inserted.rowCount)await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES ($1,$2,$3)',[actor.id,'DELEGATION_GRANTED',b.id]);
      return {id:row.id};
    });
  }
  @Post(':id/revoke') @HttpCode(200) async revoke(@Headers() h:H,@Param('id') id:string) {
    const actor=await this.identity.identity(auth(h),true);if(!uuid.test(id))throw new NotFoundException();
    return this.db.transaction(async client=>{
      const active=await client.query('SELECT id FROM employees WHERE id=$1 AND active FOR SHARE',[actor.id]);
      if(!active.rowCount)throw new UnauthorizedException();
      const found=await client.query('SELECT id,revoked_at FROM ticket_delegations WHERE id=$1 AND requester_id=$2 FOR UPDATE',[id,actor.id]);
      if(!found.rowCount)throw new NotFoundException();
      if(!found.rows[0].revoked_at){
        await client.query('UPDATE ticket_delegations SET revoked_at=now() WHERE id=$1',[id]);
        await client.query('INSERT INTO operational_audits(actor_id,action,target_id) VALUES ($1,$2,$3)',[actor.id,'DELEGATION_REVOKED',id]);
      }
      return {ok:true};
    });
  }
}
