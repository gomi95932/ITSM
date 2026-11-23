import { Controller,ForbiddenException,Get,Headers } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Database } from './database.service.js';
import { ROLE_EFFECTIVE_SQL } from './role-policy.js';

@Controller('admin/directory')
export class DirectoryController {
  constructor(private readonly auth:AuthService,private readonly db:Database){}
  @Get('status') async status(@Headers() h:Record<string,string|undefined>){
    const actor=await this.auth.identity({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});
    return this.db.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      const permission=await client.query(`SELECT 1 FROM employees e JOIN role_bindings r ON r.employee_id=e.id
        WHERE e.id=$1 AND e.active AND r.role_code='PLATFORM_ADMIN' AND ${ROLE_EFFECTIVE_SQL}`,[actor.id]);
      if(!permission.rowCount)throw new ForbiddenException({code:'DIRECTORY_ADMIN_REQUIRED'});
      const corp=process.env.DINGTALK_CORP_ID??'';
      const counts=(await client.query(`SELECT count(*)::integer AS people,
        count(*) FILTER(WHERE e.active)::integer AS active,
        count(*) FILTER(WHERE p.consecutive_absences>0 AND e.active)::integer AS missing,
        count(*) FILTER(WHERE p.disabled_by_sync_at IS NOT NULL AND NOT e.active)::integer AS disabled
        FROM directory_people p JOIN employees e ON e.id=p.employee_id WHERE p.corp_id=$1`,[corp])).rows[0];
      const runs=(await client.query(`SELECT id,state,people_count AS "peopleCount",created_count AS "createdCount",
        updated_count AS "updatedCount",disabled_count AS "disabledCount",missing_count AS "missingCount",
        error_code AS "errorCode",started_at AS "startedAt",completed_at AS "completedAt"
        FROM directory_sync_runs WHERE corp_id=$1 ORDER BY started_at DESC,id DESC LIMIT 20`,[corp])).rows;
      const lastSuccess=(await client.query(`SELECT completed_at FROM directory_sync_runs
        WHERE corp_id=$1 AND state='SUCCEEDED' ORDER BY completed_at DESC LIMIT 1`,[corp])).rows[0]?.completed_at??null;
      return {enabled:process.env.ENABLE_DIRECTORY_SYNC==='true',retireMissing:process.env.DIRECTORY_RETIRE_MISSING==='true',
        scopeMode:process.env.DINGTALK_DIRECTORY_SCOPE==='authorized'?'authorized':'pilot',
        configured:!!(corp&&process.env.DINGTALK_APP_KEY&&process.env.DINGTALK_APP_SECRET&&process.env.DINGTALK_DIRECTORY_ROOTS),
        lastSuccessAt:lastSuccess,stale:!lastSuccess||Date.now()-new Date(lastSuccess).getTime()>900000,counts,runs};
    });
  }
}
