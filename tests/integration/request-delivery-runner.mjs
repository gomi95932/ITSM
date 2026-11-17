import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { processNextRequestDelivery } from './apps/worker/dist/request-fulfillment.js';
import { queueVerifiedApprovalHint } from './apps/worker/dist/request-approval.js';

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
  if(mode==='CONCURRENT'){
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_delivery_commands WHERE state='PENDING'")).rows[0].n,1);
    assert.deepEqual(await Promise.all([processNextRequestDelivery(db,provider),processNextRequestDelivery(db,provider)]),[true,true]);
    assert.equal(observed,2,'both workers observed the same queued intent before either committed');
  }else{
    let count=0;
    while(await processNextRequestDelivery(db,provider)){if(++count>100)throw new Error('CI_DELIVERY_QUEUE_LIMIT');}
    assert.ok(count>0,'runner must process a real queued command');
  }
}finally{await db.end();}
