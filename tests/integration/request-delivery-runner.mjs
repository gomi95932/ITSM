import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { processNextRequestDelivery,prepareRequestFulfillment,recordRequestDelivery } from './apps/worker/dist/request-fulfillment.js';
import { queueVerifiedApprovalHint } from './apps/worker/dist/request-approval.js';
import { notificationRecipients } from './apps/worker/dist/notification-audience.js';

if(process.env.ITSM_DELIVERY_CI!=='true'||process.env.NODE_ENV==='production')throw new Error('DISPOSABLE_DELIVERY_CI_ONLY');
const db=new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:6});
const mode=process.env.ITSM_DELIVERY_CI_MODE;
let observed=0,release;
const barrier=new Promise(resolve=>{release=resolve;});
// Synthetic provider responses only. This runner never calls DingTalk or grants downstream access.
const provider={async inspect(instanceId){
  const a=(await db.query('SELECT * FROM request_approvals WHERE provider_instance_id=$1',[instanceId])).rows[0];
  assert.ok(a);
  if(mode==='FAIL')throw new Error('provider-private-error-sentinel');
  if(mode==='CONCURRENT'){observed++;if(observed===2)release();await barrier;}
  if(mode==='CALLBACK'){
    const client=await db.connect();
    try{await client.query('BEGIN');await queueVerifiedApprovalHint(client,{corpId:a.corp_id,instanceId,eventId:randomUUID()});await client.query('COMMIT');}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return {instanceId,corpId:a.corp_id,templateId:a.snapshot.templateId,applicantDingUserId:a.snapshot.applicant.dingUserId,
    approverDingUserIds:a.snapshot.approvers.map(person=>person.dingUserId),state:mode==='WITHDRAW'?'WITHDRAWN':'APPROVED',
    requestBinding:{reference:a.id,serviceCode:a.snapshot.serviceCode,formVersion:a.snapshot.formVersion,
      requestedValidityDays:a.snapshot.requestedValidityDays,request:a.snapshot.request}};
}};
try{
  if(mode==='DIRECT_BLOCKED'){
    const row=(await db.query(`SELECT c.approval_id,v.id,t.owner_group_id FROM request_delivery_commands c
      JOIN request_fulfillments f ON f.approval_id=c.approval_id AND f.state='READY'
      JOIN tickets t ON t.id=f.ticket_id
      JOIN ticket_events v ON v.detail->>'commandId'=c.id::text AND v.action='DELIVERY_FAILURE_REQUIRED'
      WHERE c.operation='DELIVER' AND c.state='REJECTED' AND request_delivery_has_unresolved(c.approval_id)
      ORDER BY c.completed_at DESC LIMIT 1`)).rows[0];
    assert.ok(row,'test must exercise a failed real queued delivery registration');
    await assert.rejects(()=>recordRequestDelivery(db,provider,row.approval_id,'agent-1','CI-DIRECT-BYPASS'),/DELIVERY_FAILURE_UNRESOLVED/);
    await assert.rejects(()=>prepareRequestFulfillment(db,provider,row.approval_id,'agent-1'),/DELIVERY_FAILURE_UNRESOLVED/);
    assert.deepEqual(await notificationRecipients(db,row.id),['agent-2'],'only the independent appointed peer can receive the investigation reminder');
    assert.deepEqual(await notificationRecipients(db,row.id,'agent-1'),[]);
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      await client.query('DELETE FROM group_memberships WHERE group_id=$1 AND employee_id=$2',[row.owner_group_id,'agent-2']);
      assert.deepEqual(await notificationRecipients(client,row.id,'agent-2'),[],'send-time qualification must reject a removed member');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query("UPDATE employees SET active=false WHERE id='agent-2'");
      assert.deepEqual(await notificationRecipients(client,row.id,'agent-2'),[],'send-time qualification must reject a disabled employee');
    }finally{await client.query('ROLLBACK');client.release();}
  }else if(mode==='RESOLVED_NOTICE'){
    const row=(await db.query(`SELECT v.id FROM ticket_events v JOIN request_delivery_commands c ON c.id::text=v.detail->>'commandId'
      JOIN request_delivery_resolutions r ON r.command_id=c.id WHERE v.action='DELIVERY_FAILURE_REQUIRED'
      ORDER BY r.created_at DESC LIMIT 1`)).rows[0];
    assert.ok(row,'test must resolve a real queued failed-delivery registration');
    assert.deepEqual(await notificationRecipients(db,row.id),[],'resolved obligations must suppress queued reminders');
    assert.deepEqual(await notificationRecipients(db,row.id,'agent-2'),[]);
  }else if(mode==='CONCURRENT'){
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_delivery_commands WHERE state='PENDING'")).rows[0].n,1);
    assert.deepEqual(await Promise.all([processNextRequestDelivery(db,provider),processNextRequestDelivery(db,provider)]),[true,true]);
    assert.equal(observed,2,'both workers observed the same queued intent before either committed');
  }else{
    let count=0;
    while(await processNextRequestDelivery(db,provider)){if(++count>100)throw new Error('CI_DELIVERY_QUEUE_LIMIT');}
    assert.ok(count>0,'runner must process a real queued command');
  }
}finally{await db.end();}
