import {Injectable,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {OperationLogDetail,OperationLogEntry,OperationLogList} from '@itsm/contracts';
import type {Identity} from './auth.service.js';
import {Database} from './database.service.js';
import {ROLE_AUTHORIZATION_LOCK,ROLE_EFFECTIVE_SQL} from './role-policy.js';
import {operationLogChanges,operationLogFilters,operationLogSnapshot,redactLogText} from './operation-logs.policy.js';

const columns=`l.id,l.module,l.actor_id AS "actorId",e.display_name AS "actorName",l.object_id AS "objectId",
  l.object_name AS "objectName",l.action,l.result,l.reason,l.created_at AS "createdAt"`;
const safeEntry=(row:OperationLogEntry):OperationLogEntry=>({id:row.id,module:row.module,actorId:row.actorId,
  actorName:row.actorName?redactLogText(row.actorName):null,objectId:row.objectId,
  objectName:redactLogText(row.objectName),action:row.action,result:row.result,createdAt:row.createdAt,
  reason:row.reason?redactLogText(row.reason):null});
@Injectable()
export class OperationLogsService {
  constructor(private readonly db:Database){}
  private async read<T>(actor:Identity,fn:(c:PoolClient)=>Promise<T>){return this.db.transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await c.query('SELECT pg_advisory_xact_lock_shared($1)',[ROLE_AUTHORIZATION_LOCK]);
    if(!(await c.query(`SELECT 1 FROM role_bindings r WHERE r.employee_id=$1 AND r.role_code='PLATFORM_ADMIN' AND ${ROLE_EFFECTIVE_SQL} LIMIT 1`,[actor.id])).rowCount)throw new NotFoundException();
    return fn(c);
  });}
  async list(actor:Identity,input:Record<string,unknown>):Promise<OperationLogList>{
    const f=operationLogFilters(input);return this.read(actor,async c=>{
      const values:unknown[]=[],conditions:string[]=[];
      const add=(sql:string,value:unknown)=>{values.push(value);conditions.push(sql.replaceAll('?',`$${values.length}`));};
      if(f.module)add('l.module=?',f.module);if(f.result)add('l.result=?',f.result);
      if(f.object)add('(l.object_id=? OR l.source_id=?)',f.object);
      if(f.from)add('l.created_at>=?::timestamptz',f.from);if(f.to)add('l.created_at<=?::timestamptz',f.to);
      // Literal matching keeps user wildcard characters from becoming SQL patterns.
      if(f.q)add('(strpos(lower(l.object_name),lower(?))>0 OR strpos(lower(l.object_id),lower(?))>0 OR strpos(lower(l.action),lower(?))>0 OR strpos(lower(COALESCE(l.reason,\'\')),lower(?))>0)',f.q);
      if(f.actor)add('(strpos(lower(COALESCE(l.actor_id,\'\')),lower(?))>0 OR strpos(lower(COALESCE(e.display_name,\'\')),lower(?))>0)',f.actor);
      const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:'';
      const from=`FROM operation_log_entries l LEFT JOIN employees e ON e.id=l.actor_id ${where}`;
      const total=Number((await c.query(`SELECT count(*) AS total ${from}`,values)).rows[0].total);
      const rows=await c.query<OperationLogEntry>(`SELECT ${columns} ${from} ORDER BY l.created_at DESC,l.id DESC LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,f.size,(f.page-1)*f.size]);
      return {items:rows.rows.map(safeEntry),total,page:f.page,size:f.size};
    });
  }
  async detail(actor:Identity,id:string):Promise<OperationLogDetail>{
    if(!/^[a-z-]+:[A-Za-z0-9:._-]{1,240}$/.test(id))throw new NotFoundException();
    return this.read(actor,async c=>{
      const row=(await c.query(`SELECT ${columns},l.source_table AS "sourceTable",l.source_id AS "sourceId",l.request_id AS "requestId",
        l.execution_principal AS "executionPrincipal",l.before_value AS "beforeValue",l.after_value AS "afterValue"
        FROM operation_log_entries l LEFT JOIN employees e ON e.id=l.actor_id WHERE l.id=$1`,[id])).rows[0];
      if(!row)throw new NotFoundException();
      const beforeValue=operationLogSnapshot(row.beforeValue,row.module),afterValue=operationLogSnapshot(row.afterValue,row.module);
      return {...safeEntry(row),sourceTable:row.sourceTable,sourceId:row.sourceId,requestId:row.requestId,
        executionPrincipal:row.executionPrincipal?redactLogText(row.executionPrincipal):null,beforeValue,afterValue,
        valueMeaning:['SUBMITTED','REJECTED'].includes(row.result)?'PROPOSED':'RECORDED',...operationLogChanges(beforeValue,afterValue)};
    });
  }
}
