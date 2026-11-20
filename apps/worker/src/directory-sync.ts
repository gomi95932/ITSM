import { createHash } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { DirectoryProvider,DirectorySnapshot } from './directory-provider.js';

export type DirectorySettings={corpId:string;roots:number[];retireMissing:boolean;maxRemovalPercent:number};
export const directoryScope=(settings:DirectorySettings)=>createHash('sha256')
  .update(JSON.stringify([settings.corpId,[...settings.roots].sort((a,b)=>a-b)])).digest('hex');
export const directoryEmployeeId=(corp:string,user:string)=>`ding:${createHash('sha256').update(JSON.stringify([corp,user])).digest('hex')}`;
export function directorySettings(env:NodeJS.ProcessEnv):DirectorySettings|undefined {
  if(env.ENABLE_DIRECTORY_SYNC!=='true')return undefined;
  const roots=(env.DINGTALK_DIRECTORY_ROOTS??'').split(',').map(value=>value.trim());
  const rawPercent=env.DIRECTORY_MAX_REMOVAL_PERCENT??'10';
  const percent=Number(rawPercent);
  if(!env.DINGTALK_CORP_ID?.trim()||!roots.length||roots.some(value=>!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)
    ||new Set(roots.map(Number)).size!==roots.length||!rawPercent.trim()||!Number.isFinite(percent)||percent<0||percent>100)
    throw new Error('DIRECTORY_CONFIG_INVALID');
  return {corpId:env.DINGTALK_CORP_ID.trim(),roots:roots.map(Number),retireMissing:env.DIRECTORY_RETIRE_MISSING==='true',maxRemovalPercent:percent};
}
const safeErrors=new Set(['DIRECTORY_PROVIDER_INVALID','DIRECTORY_PROVIDER_UNAVAILABLE','DIRECTORY_TOKEN_UNAVAILABLE',
  'DIRECTORY_EMPTY_SNAPSHOT','DIRECTORY_SCOPE_TOO_LARGE','DIRECTORY_SNAPSHOT_CHANGED','DIRECTORY_IDENTITY_CONFLICT','DIRECTORY_REMOVAL_LIMIT']);

async function applySnapshot(client:PoolClient,runId:string,settings:DirectorySettings,snapshot:DirectorySnapshot){
  const scope=directoryScope(settings),ids=new Set(snapshot.people.map(person=>person.userId));
  if(!ids.size)throw new Error('DIRECTORY_EMPTY_SNAPSHOT');
  if(ids.size!==snapshot.people.length)throw new Error('DIRECTORY_SNAPSHOT_CHANGED');
  const previous=await client.query(`SELECT p.ding_user_id,p.employee_id,p.consecutive_absences,e.active FROM directory_people p
    JOIN employees e ON e.id=p.employee_id WHERE p.corp_id=$1 AND p.scope_hash=$2 FOR UPDATE OF p,e`,[settings.corpId,scope]);
  const missing=previous.rows.filter(row=>!ids.has(row.ding_user_id));
  const candidates=missing.filter(row=>row.consecutive_absences>=1&&row.active);
  const activeCount=previous.rows.filter(row=>row.active).length;
  if(settings.retireMissing&&activeCount&&candidates.length*100/activeCount>settings.maxRemovalPercent)
    throw new Error('DIRECTORY_REMOVAL_LIMIT');
  let created=0,updated=0,disabled=0;
  for(const person of snapshot.people){
    const old=await client.query(`SELECT employee_id FROM directory_people WHERE corp_id=$1 AND ding_user_id=$2`,[settings.corpId,person.userId]);
    const link=await client.query(`SELECT employee_id FROM identity_links WHERE corp_id=$1 AND ding_user_id=$2 FOR UPDATE`,[settings.corpId,person.userId]);
    if(old.rowCount&&link.rowCount&&old.rows[0].employee_id!==link.rows[0].employee_id)throw new Error('DIRECTORY_IDENTITY_CONFLICT');
    const id:string=old.rows[0]?.employee_id??link.rows[0]?.employee_id??directoryEmployeeId(settings.corpId,person.userId);
    // Do not take over a pre-existing unrelated employee, or bypass a locally disabled account.
    const employee=await client.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[id]);
    if(!old.rowCount&&!link.rowCount&&employee.rowCount)throw new Error('DIRECTORY_IDENTITY_CONFLICT');
    if(!employee.rowCount){await client.query('INSERT INTO employees(id,display_name) VALUES($1,$2)',[id,person.name]);created++;}
    else{await client.query('UPDATE employees SET display_name=$2 WHERE id=$1',[id,person.name]);updated++;}
    const conflicting=await client.query('SELECT ding_user_id FROM identity_links WHERE corp_id=$1 AND employee_id=$2',[settings.corpId,id]);
    if(conflicting.rowCount&&conflicting.rows[0].ding_user_id!==person.userId)throw new Error('DIRECTORY_IDENTITY_CONFLICT');
    await client.query(`INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES($1,$2,$3)
      ON CONFLICT(corp_id,ding_user_id) DO NOTHING`,[settings.corpId,person.userId,id]);
    const persistedLink=await client.query(`SELECT employee_id FROM identity_links WHERE corp_id=$1 AND ding_user_id=$2 FOR UPDATE`,
      [settings.corpId,person.userId]);
    if(persistedLink.rows[0]?.employee_id!==id)throw new Error('DIRECTORY_IDENTITY_CONFLICT');
    await client.query(`INSERT INTO directory_people(corp_id,ding_user_id,employee_id,scope_hash,department_ids,job_title,last_seen_run)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(corp_id,ding_user_id) DO UPDATE SET
      scope_hash=EXCLUDED.scope_hash,department_ids=EXCLUDED.department_ids,job_title=EXCLUDED.job_title,
      last_seen_at=clock_timestamp(),last_seen_run=EXCLUDED.last_seen_run,consecutive_absences=0`,
    [settings.corpId,person.userId,id,scope,JSON.stringify(person.departmentIds),person.jobTitle,runId]);
  }
  for(const person of missing){
    await client.query('UPDATE directory_people SET consecutive_absences=consecutive_absences+1 WHERE corp_id=$1 AND ding_user_id=$2',
      [settings.corpId,person.ding_user_id]);
    if(settings.retireMissing&&person.consecutive_absences>=1){
      const changed=await client.query('UPDATE employees SET active=false WHERE id=$1 AND active RETURNING id',[person.employee_id]);
      disabled+=changed.rowCount??0;
      if(changed.rowCount)await client.query(`UPDATE directory_people SET disabled_by_sync_at=clock_timestamp()
        WHERE corp_id=$1 AND ding_user_id=$2`,[settings.corpId,person.ding_user_id]);
    }
  }
  await client.query(`UPDATE directory_sync_runs SET state='SUCCEEDED',people_count=$2,created_count=$3,
    updated_count=$4,disabled_count=$5,missing_count=$6,completed_at=clock_timestamp() WHERE id=$1`,
  [runId,snapshot.people.length,created,updated,disabled,missing.length]);
  return {created,updated,disabled,missing:missing.length,people:snapshot.people.length};
}

export async function synchronizeDirectory(pool:Pool,settings:DirectorySettings,provider:DirectoryProvider){
  const client=await pool.connect();let locked=false,runId:string|undefined;
  try{
    locked=(await client.query('SELECT pg_try_advisory_lock(71820535) AS locked')).rows[0].locked;
    if(!locked)return {state:'BUSY' as const};
    // Interrupted process runs never become authoritative snapshots.
    await client.query(`UPDATE directory_sync_runs SET state='FAILED',error_code='DIRECTORY_INTERRUPTED',completed_at=clock_timestamp()
      WHERE corp_id=$1 AND state='RUNNING'`,[settings.corpId]);
    runId=(await client.query(`INSERT INTO directory_sync_runs(corp_id,scope_hash,state) VALUES($1,$2,'RUNNING') RETURNING id`,
      [settings.corpId,directoryScope(settings)])).rows[0].id;
    const snapshot=await provider.snapshot(AbortSignal.timeout(120000));
    await client.query('BEGIN');
    try{
      await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
      const counts=await applySnapshot(client,runId!,settings,snapshot);
      await client.query('COMMIT');return {state:'SUCCEEDED' as const,...counts};
    }catch(error){await client.query('ROLLBACK');throw error;}
  }catch(error){
    const code=error instanceof Error&&safeErrors.has(error.message)?error.message:'DIRECTORY_SYNC_FAILED';
    if(runId)await client.query(`UPDATE directory_sync_runs SET state='FAILED',error_code=$2,completed_at=clock_timestamp() WHERE id=$1`,[runId,code]);
    return {state:'FAILED' as const,errorCode:code};
  }finally{
    try{if(locked)await client.query('SELECT pg_advisory_unlock(71820535)');}
    catch(error){client.release(true);throw error;}
    client.release();
  }
}
