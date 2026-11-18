import { randomUUID } from 'node:crypto';
import { createFulfillmentFixture, fulfillmentSql as sql, literal as q } from './fulfillment.mjs';

// Synthetic, non-deliverable events in disposable CI only; never send a real notification.
export async function createNotificationReportFixture({ day='2025-06-14', unexpanded=false }={}) {
  if (unexpanded && process.env.ITSM_NOTIFICATION_REPORT_WORKER_STOPPED!=='true') throw new Error('REPORT_FIXTURE_REQUIRES_STOPPED_CI_WORKER');
  const fixture = await createFulfillmentFixture({ state:null });
  const marker = `private-notice-${randomUUID()}`, eventId = randomUUID(), outboxId = randomUUID();
  const states = [['DELIVERED',0,null],['SIMULATED',0,null],['DEAD',5,'TOKEN_FAILED'],
    ['REVIEW_REQUIRED',1,'DINGTALK_SEND_UNCONFIRMED'],['SKIPPED',0,'RECIPIENT_NO_LONGER_AUTHORIZED'],
    ['PENDING',0,null],['PENDING',2,'PROVIDER_UNAVAILABLE'],['SENDING',0,null],
    ['SENDING',1,'DELIVERY_NOT_CONFIRMED'],['DISPATCHING',0,null],['PRIVATE_STATE',1,marker]];
  const deliveries = states.map(([state,attempts,error]) => ({ id:randomUUID(), employee:randomUUID(), state, attempts, error }));
  const otherEvents = [{ day:`${day} 12:00:00+08`, expanded:true },
    ...(unexpanded?[{ day:`${day} 13:00:00+08`, expanded:false }]:[]),
    { day:`${day} 00:00:00+08`, expanded:true, offset:"-interval '1 second'", delivery:true },
    { day:`${day} 00:00:00+08`, expanded:true, offset:"+interval '1 day'", delivery:true }]
    .map(row=>({...row,eventId:randomUUID(),outboxId:randomUUID()}));
  await sql(`BEGIN;
    INSERT INTO employees(id,display_name) VALUES ${deliveries.map(row=>`(${q(row.employee)},${q(marker)})`).join(',')};
    INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,detail,request_id,created_at)
      VALUES(${q(eventId)},${q(fixture.ticketId)},'system','CI_REPORT','IN_PROGRESS',${q(JSON.stringify({secret:marker}))},
        ${q(marker)},${q(`${day} 00:00:00+08`)});
    INSERT INTO outbox_events(id,ticket_id,event_id,kind,payload,created_at,expanded_at)
      VALUES(${q(outboxId)},${q(fixture.ticketId)},${q(eventId)},'CI_REPORT',${q(JSON.stringify({secret:marker}))},
        ${q(`${day} 00:00:00+08`)},now());
    INSERT INTO notification_deliveries(id,outbox_id,employee_id,state,attempts,last_error,provider_task_id,provider_recipient_hash,next_at)
      VALUES ${deliveries.map(row=>`(${q(row.id)},${q(outboxId)},${q(row.employee)},${q(row.state)},${row.attempts},
        ${q(row.error)},${q(marker)},${q(marker)},now()+interval '1 day')`).join(',')};
    ${otherEvents.map(row=>`INSERT INTO ticket_events(id,ticket_id,actor_id,action,to_status,request_id,created_at)
        VALUES(${q(row.eventId)},${q(fixture.ticketId)},'system','CI_REPORT','IN_PROGRESS',${q(marker)},
          ${q(row.day)}::timestamptz ${row.offset??''});
      INSERT INTO outbox_events(id,ticket_id,event_id,kind,payload,created_at,expanded_at)
        VALUES(${q(row.outboxId)},${q(fixture.ticketId)},${q(row.eventId)},'CI_REPORT','{}',
          ${q(row.day)}::timestamptz ${row.offset??''},${row.expanded?'now()':'NULL'});
      ${row.delivery?`INSERT INTO notification_deliveries(outbox_id,employee_id,state,last_error)
        VALUES(${q(row.outboxId)},${q(deliveries[0].employee)},'DEAD',${q(marker)});`:''}`).join('\n')}
    COMMIT;`);
  return { ...fixture, marker, day, deliveries, outboxId };
}
