import type {Pool,PoolClient} from 'pg';
import {advanceAutomaticDispatch} from '@itsm/workflow';

type RecordExpiry=(client:PoolClient,row:any,action:string,detail:object,from:string,to:string,previous?:any)=>Promise<void>;

export async function expireAssignments(db:Pool,record:RecordExpiry){
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(71820512)');
    const rows=await client.query(`SELECT * FROM tickets WHERE pending_assignee_id IS NOT NULL
      AND assignment_due_at<=now() AND status NOT IN ('CLOSED','CANCELLED','REJECTED')
      ORDER BY assignment_due_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`);
    for(const row of rows.rows){
      if(await advanceAutomaticDispatch(client,row.id))continue;
      const updated=await client.query(`UPDATE tickets SET pending_group_id=NULL,pending_assignee_id=NULL,
        assignment_kind=NULL,assignment_state='EXPIRED',assignment_due_at=NULL,assignment_offered_at=NULL,
        assignment_policy_version_id=NULL,pending_classification=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[row.id]);
      await record(client,updated.rows[0],'ASSIGNMENT_EXPIRED',{
        reason:'CANDIDATE_DID_NOT_ACCEPT',assignmentKind:row.assignment_kind,
        targetServiceCode:row.pending_classification?.serviceCode,
        targetGroupId:row.pending_group_id,targetAssigneeId:row.pending_assignee_id,
        assignmentPolicyVersionId:row.assignment_policy_version_id,assignmentDueAt:row.assignment_due_at,
      },row.status,row.status,row);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
