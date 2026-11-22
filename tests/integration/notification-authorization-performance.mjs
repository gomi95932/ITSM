import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expandPendingNotifications,refreshFulfillmentNotificationAudiences,refreshWaitingNotificationAudiences}
  from '../../apps/worker/dist/notification-audience.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_AUTHORIZATION_CI_ONLY');
const pool=new pg.Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:6,statement_timeout:10000});
try{
  for(const [kind,maintain] of [['expand',expandPendingNotifications],['waiting',refreshWaitingNotificationAudiences],
    ['fulfillment',refreshFulfillmentNotificationAudiences]]){
    const group=`notification-${randomUUID()}`,engineer=`engineer-${randomUUID()}`,ids=[];
    await pool.query('INSERT INTO support_groups(id,name) VALUES($1,$1)',[group]);
    await pool.query('INSERT INTO employees(id,display_name) VALUES($1,$1)',[engineer]);
    await pool.query('INSERT INTO group_memberships(employee_id,group_id) VALUES($1,$2)',[engineer,group]);
    await pool.query("INSERT INTO service_catalog(code,type,form_version,group_id,name) VALUES($1,'REQ',1,$1,'CI notification fixture')",[group]);
    for(let i=0;i<21;i++){
      const ticket=randomUUID(),event=randomUUID(),outbox=randomUUID();ids.push(outbox);
      const action=kind==='waiting'?'WAITING_VENDOR_FOLLOW_UP_DUE':kind==='fulfillment'?'FULFILLMENT_REVOKE_REQUIRED':'ACCEPT';
      await pool.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,assignee_id,service_code,
        service_type,form_version,subject,description,fields,impact,urgency,priority,status,
        waiting_reason_code,waiting_since,waiting_due_at)
        VALUES($1::uuid,$1::text,'employee-1','employee-1',$2,$3,$2,'REQ',1,'CI notification','Synthetic fixture',
          '{}','INDIVIDUAL','LOW','P4',$4,CASE WHEN $5 THEN 'VENDOR_SUPPORT' END,
          CASE WHEN $5 THEN now()-interval '2 hours' END,CASE WHEN $5 THEN now()-interval '1 hour' END)`,
      [ticket,group,engineer,kind==='waiting'?'WAITING_VENDOR':'IN_PROGRESS',kind==='waiting']);
      await pool.query(`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id)
        VALUES($1::uuid,$2,'system:scheduler',$3,'IN_PROGRESS',$1::uuid::text)`,[event,ticket,action]);
      if(kind==='waiting')await pool.query(`INSERT INTO ticket_waiting_signals(ticket_id,group_id,waiting_status,
        waiting_reason_code,waiting_since,waiting_due_at,event_id)
        SELECT id,owner_group_id,status,waiting_reason_code,waiting_since,waiting_due_at,$2 FROM tickets WHERE id=$1`,[ticket,event]);
      if(kind==='fulfillment'){
        const approval=randomUUID(),fulfillment=randomUUID();
        await pool.query(`INSERT INTO request_approvals(id,ticket_id,corp_id,snapshot,expires_at,state,provider_instance_id,last_verified_at)
          VALUES($1::uuid,$2,'ci-notification','{"applicant":{"employeeId":"employee-1"},"approvers":[]}',
            now()+interval '1 day','APPROVED',$1::text,now())`,[approval,ticket]);
        await pool.query(`INSERT INTO request_fulfillments(id,approval_id,ticket_id,assignee_id,ready_until,state,delivered_at,access_expires_at)
          VALUES($1,$2,$3,$4,now()+interval '1 day','REVOKE_DUE',now()-interval '2 hours',now()-interval '1 hour')`,
        [fulfillment,approval,ticket,engineer]);
        await pool.query(`INSERT INTO request_fulfillment_signals(fulfillment_id,group_id,kind,escalate_at,event_id)
          VALUES($1,$2,'REVOKE_REQUIRED',now()+interval '1 hour',$3)`,[fulfillment,group,event]);
      }
      await pool.query(`INSERT INTO outbox_events(id,ticket_id,event_id,kind,payload,expanded_at)
        VALUES($1,$2,$3,'TICKET_CHANGED','{}',CASE WHEN $4 THEN now() END)`,[outbox,ticket,event,kind!=='expand']);
    }
    let releaseFirst,markFirst,firstId,maintenance,writer,pendingWriter;
    const firstMayContinue=new Promise(resolve=>{releaseFirst=resolve;});
    const firstCommittedUpdate=new Promise(resolve=>{markFirst=resolve;});
    const observedPool={connect:async()=>{
      const client=await pool.connect();
      return {release:()=>client.release(),query:async(...args)=>{
        const result=await client.query(...args);
        if(!firstId&&typeof args[0]==='string'&&args[0].startsWith('UPDATE outbox_events SET expanded_at=')){
          firstId=args[1][0];markFirst();await firstMayContinue;
        }
        return result;
      }};
    }};
    try{
      maintenance=maintain(observedPool);
      await Promise.race([firstCommittedUpdate,maintenance.then(()=>{throw new Error('FIRST_NOTIFICATION_NOT_OBSERVED');})]);
      writer=await pool.connect();await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='2s'");
      const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pendingWriter=writer.query('SELECT pg_advisory_xact_lock(71820512)');pendingWriter.catch(()=>{});
      let waiting=false;
      for(let i=0;i<100&&!waiting;i++){
        waiting=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0].waiting;
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true,`${kind}: the writer must actually queue behind a notification`);
      releaseFirst();await pendingWriter;
      const checked=(await writer.query(`SELECT count(*)::integer AS n FROM outbox_events
        WHERE id=ANY($1::uuid[]) AND audience_checked_at IS NOT NULL`,[ids])).rows[0].n;
      assert.equal(checked,1,`${kind}: authorization writers must proceed after one event`);
      await writer.query('UPDATE employees SET active=false WHERE id=$1',[engineer]);await writer.query('COMMIT');
      await maintenance;
      const count=async()=>(await pool.query(`SELECT count(*)::integer AS n FROM outbox_events
        WHERE id=ANY($1::uuid[]) AND audience_checked_at IS NOT NULL`,[ids])).rows[0].n;
      assert.equal(await count(),20,`${kind}: a poll processes at most 20 events`);
      await Promise.all([maintain(pool),maintain(pool)]);
      assert.equal(await count(),21,`${kind}: the next poll reaches the remaining event`);
      const delivered=await pool.query(`SELECT outbox_id FROM notification_deliveries
        WHERE outbox_id=ANY($1::uuid[]) AND employee_id=$2`,[ids,engineer]);
      assert.deepEqual(delivered.rows.map(row=>row.outbox_id),[firstId],`${kind}: later events must see the committed revocation`);
      console.log(JSON.stringify({operation:`notification-${kind}-fairness`,events:21,checksBeforeWriter:checked,status:'passed'}));
    }finally{
      releaseFirst();
      if(writer){await pendingWriter?.catch(()=>{});await writer.query('ROLLBACK').catch(()=>{});writer.release();}
      await maintenance?.catch(()=>{});
    }
  }
}finally{await pool.end();}
