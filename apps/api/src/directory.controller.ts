import { BadRequestException,ConflictException,Controller,ForbiddenException,Get,Headers,HttpCode,Post } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DIRECTORY_AUTO_INTERVAL_MS,DIRECTORY_STALE_AFTER_MS } from '@itsm/contracts';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { ROLE_EFFECTIVE_SQL } from './role-policy.js';

@Controller('admin/directory')
export class DirectoryController {
  constructor(private readonly auth:AuthService,private readonly db:Database){}
  private async authorize(client:PoolClient,actorId:string){
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const permission=await client.query(`SELECT 1 FROM employees e JOIN role_bindings r ON r.employee_id=e.id
      WHERE e.id=$1 AND e.active AND r.role_code='PLATFORM_ADMIN' AND ${ROLE_EFFECTIVE_SQL}`,[actorId]);
    if(!permission.rowCount)throw new ForbiddenException({code:'DIRECTORY_ADMIN_REQUIRED'});
  }
  private configured(){return !!(process.env.DINGTALK_CORP_ID?.trim()&&process.env.DINGTALK_APP_KEY
    &&process.env.DINGTALK_APP_SECRET&&process.env.DINGTALK_DIRECTORY_ROOTS?.trim());}
  @Post('sync') @HttpCode(202)
  async sync(@Headers() h:Record<string,string|undefined>){
    const actor=await this.auth.identity({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']},true);
    const key=h['idempotency-key'];
    if(!key||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
      throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    return this.db.transaction(async client=>{
      await this.authorize(client,actor.id);
      if(process.env.ENABLE_DIRECTORY_SYNC!=='true'||!this.configured())throw new ConflictException({code:'DIRECTORY_SYNC_NOT_ENABLED'});
      const corp=process.env.DINGTALK_CORP_ID!.trim();
      const replay=await client.query(`SELECT id,state FROM directory_sync_runs
        WHERE corp_id=$1 AND requested_by=$2 AND request_key=$3`,[corp,actor.id,key]);
      if(replay.rowCount)return {...replay.rows[0],reused:true};
      const locked=(await client.query('SELECT pg_try_advisory_xact_lock(71820535) AS locked')).rows[0].locked;
      if(!locked)throw new ConflictException({code:'DIRECTORY_SYNC_BUSY'});
      const existing=await client.query(`SELECT id,state FROM directory_sync_runs WHERE corp_id=$1 AND state='QUEUED' LIMIT 1`,[corp]);
      if(existing.rowCount)return {...existing.rows[0],reused:true};
      // Recheck after serialization so concurrent retries with the same key remain idempotent.
      const repeated=await client.query(`SELECT id,state FROM directory_sync_runs
        WHERE corp_id=$1 AND requested_by=$2 AND request_key=$3`,[corp,actor.id,key]);
      if(repeated.rowCount)return {...repeated.rows[0],reused:true};
      const result=await client.query(`INSERT INTO directory_sync_runs(corp_id,scope_hash,state,trigger_source,requested_by,request_key)
        VALUES($1,'pending','QUEUED','MANUAL',$2,$3) RETURNING id,state`,[corp,actor.id,key]);
      return {...result.rows[0],reused:false};
    });
  }
  @Get('status') async status(@Headers() h:Record<string,string|undefined>){
    const actor=await this.auth.identity({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});
    return this.db.transaction(async client=>{
      await this.authorize(client,actor.id);
      const corp=process.env.DINGTALK_CORP_ID?.trim()??'';
      const counts=(await client.query(`SELECT count(*)::integer AS people,
        count(*) FILTER(WHERE e.active)::integer AS active,
        count(*) FILTER(WHERE p.consecutive_absences>0 AND e.active)::integer AS missing,
        count(*) FILTER(WHERE p.disabled_by_sync_at IS NOT NULL AND NOT e.active)::integer AS disabled
        FROM directory_people p JOIN employees e ON e.id=p.employee_id WHERE p.corp_id=$1`,[corp])).rows[0];
      const runs=(await client.query(`SELECT id,state,people_count AS "peopleCount",created_count AS "createdCount",
        updated_count AS "updatedCount",disabled_count AS "disabledCount",missing_count AS "missingCount",
        error_code AS "errorCode",error_details AS "errorDetails",trigger_source AS "triggerSource",
        started_at AS "startedAt",completed_at AS "completedAt"
        FROM directory_sync_runs WHERE corp_id=$1 ORDER BY started_at DESC,id DESC LIMIT 20`,[corp])).rows;
      const lastSuccess=(await client.query(`SELECT completed_at FROM directory_sync_runs
        WHERE corp_id=$1 AND state='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1`,[corp])).rows[0]?.completed_at??null;
      const lastAutomatic=(await client.query(`SELECT max(started_at) AS at FROM directory_sync_runs
        WHERE corp_id=$1 AND trigger_source='AUTOMATIC'`,[corp])).rows[0]?.at;
      const active=(await client.query(`SELECT id,state FROM directory_sync_runs WHERE corp_id=$1 AND state IN ('QUEUED','RUNNING')
        ORDER BY requested_at LIMIT 1`,[corp])).rows[0]??null;
      return {enabled:process.env.ENABLE_DIRECTORY_SYNC==='true',retireMissing:process.env.DIRECTORY_RETIRE_MISSING==='true',
        scopeMode:process.env.DINGTALK_DIRECTORY_SCOPE==='authorized'?'authorized':'pilot',
        configured:this.configured(),automaticIntervalHours:24,
        nextAutomaticAt:lastAutomatic?new Date(new Date(lastAutomatic).getTime()+DIRECTORY_AUTO_INTERVAL_MS).toISOString():null,
        activeRun:active,lastSuccessAt:lastSuccess,
        stale:!lastSuccess||Date.now()-new Date(lastSuccess).getTime()>DIRECTORY_STALE_AFTER_MS,counts,runs};
    });
  }
}
