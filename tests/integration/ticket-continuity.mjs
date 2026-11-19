import assert from 'node:assert/strict';
import {action,fixture,ok,quote,request,sql,until} from '../support/ticket-continuity.mjs';

const f=await fixture();
let ticket=await f.create();
const initial=ticket,detail=()=>ok(request(`/tickets/${ticket.id}`,f.owner));
const sla=await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`);
assert.equal((await detail()).canProcess,true);
await f.appoint(false);
assert.equal((await detail()).canProcess,false);
assert.equal((await detail()).canCorrectClassification,false);
assert.equal((await detail()).ownerContinuityRequired,true);
const resolution={comment:'已验证恢复',resolutionCategory:'故障恢复',evidence:'服务验证完成'};
assert.equal((await action(ticket,f.owner,'RESOLVE',resolution)).data.code,'TICKET_CONTINUITY_REQUIRED');
assert.equal((await request(`/tickets/${ticket.id}/classification`,f.owner,{expectedVersion:ticket.version,serviceCode:'INC-PC',formVersion:1,fields:{},reason:'分类复核'})).data.code,'TICKET_CONTINUITY_REQUIRED');
assert.equal((await detail()).assigneeId,initial.assigneeId);
await until(async()=>await sql(`SELECT reason FROM ticket_routing_alerts WHERE ticket_id=${quote(ticket.id)} AND resolved_at IS NULL`)==='OWNER_APPOINTMENT_REQUIRED');
assert.equal((await action(ticket,f.peer,'INITIATE_HANDOVER',{targetGroupId:f.group,targetAssigneeId:f.peer,reason:'非主管尝试'})).data.code,'CONTINUITY_MANAGER_REQUIRED');
assert.equal((await action(ticket,f.owner,'CONTINUATION_PROPOSE',{reason:'过长授权',dueAt:new Date(Date.now()+8*86400000).toISOString()})).data.code,'CONTINUATION_VALIDITY_INVALID');
ticket=await ok(action(ticket,f.lead,'CONTINUATION_PROPOSE',{reason:'临时完成原单',dueAt:new Date(Date.now()+3600000).toISOString()}));
let grant=(await detail()).continuations.find(item=>item.current&&item.status==='PENDING');
assert.equal((await action(ticket,f.lead,'CONTINUATION_APPROVE',{continuationId:grant.id,reason:'自审尝试'})).data.code,'CONTINUATION_INDEPENDENT_REVIEW_REQUIRED');
assert.equal((await action(ticket,f.peer,'CONTINUATION_APPROVE',{continuationId:grant.id,reason:'普通员工尝试'})).data.code,'CONTINUITY_MANAGER_REQUIRED');
const race=await Promise.all([1,2].map(()=>action(ticket,f.reviewer,'CONTINUATION_APPROVE',{continuationId:grant.id,reason:'独立核对授权边界'})));
assert.deepEqual(race.map(item=>item.status).sort(),[200,409]);ticket=race.find(item=>item.status===200).data;
assert.equal((await detail()).canProcess,true);
assert.equal((await detail()).canClaim,false,'exception never restores general position appointment');
assert.equal((await ok(request(`/tickets/${ticket.id}`,'employee-1'))).continuations,undefined,'employee view never exposes internal grant records');
ticket=await ok(action(ticket,f.owner,'WAIT_VENDOR',{comment:'跟进厂商处理',vendorReference:'CI-REF',vendorOwner:'当前责任人',
  waitingReason:'VENDOR_SUPPORT',dueAt:new Date(Date.now()+3600000).toISOString()}));
assert.equal((await detail()).canProcess,true,'ordinary version changes do not invalidate the scoped grant');
ticket=await ok(action(ticket,f.owner,'RESUME_VENDOR',{comment:'厂商响应后继续验证'}));
assert.equal(ticket.status,'IN_PROGRESS');
assert.equal((await detail()).waiting,null);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`),sla);
ticket=await ok(action(ticket,f.owner,'WAIT_VENDOR',{comment:'继续跟进厂商验证',vendorReference:'CI-REF-2',vendorOwner:'当前责任人',
  waitingReason:'VENDOR_SUPPORT',dueAt:new Date(Date.now()+3600000).toISOString()}));
ticket=await ok(action(ticket,f.lead,'CONTINUATION_REVOKE',{continuationId:grant.id,reason:'提前结束临时授权'}));
assert.equal((await action(ticket,f.owner,'RESOLVE',resolution)).data.code,'TICKET_CONTINUITY_REQUIRED');
assert.equal((await action(ticket,f.owner,'RESUME_VENDOR',{comment:'已撤权，不得恢复处理'})).data.code,'TICKET_CONTINUITY_REQUIRED');
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`),sla);

// A separately reviewed grant expires at the API boundary, without a worker scan.
ticket=await ok(action(ticket,f.owner,'CONTINUATION_PROPOSE',{reason:'短期限验证',dueAt:new Date(Date.now()+12000).toISOString()}));
grant=(await detail()).continuations.find(item=>item.current&&item.status==='PENDING');
ticket=await ok(action(ticket,f.lead,'CONTINUATION_APPROVE',{continuationId:grant.id,reason:'独立批准短期窗口'}));
assert.equal((await detail()).canProcess,true);
await new Promise(resolve=>setTimeout(resolve,12500));
assert.equal((await detail()).canProcess,false);
assert.equal((await action(ticket,f.owner,'RESOLVE',resolution)).data.code,'TICKET_CONTINUITY_REQUIRED');
assert.equal((await action(ticket,f.owner,'RESUME_VENDOR',{comment:'授权已到期，不得恢复处理'})).data.code,'TICKET_CONTINUITY_REQUIRED');

ticket=await ok(action(ticket,f.owner,'CONTINUATION_PROPOSE',{reason:'交接前短期支持',dueAt:new Date(Date.now()+3600000).toISOString()}));
grant=(await detail()).continuations.find(item=>item.current&&item.status==='PENDING');
ticket=await ok(action(ticket,f.lead,'CONTINUATION_APPROVE',{continuationId:grant.id,reason:'独立复核限期支持'}));
const beforeHandover=ticket;
ticket=await ok(action(ticket,f.lead,'INITIATE_HANDOVER',{targetGroupId:f.group,targetAssigneeId:f.peer,reason:'主管安排逐单交接'}));
assert.equal(ticket.assigneeId,f.owner,'manager initiation does not fake recipient acceptance');
assert.equal(ticket.pendingAssigneeId,f.peer);
assert.equal(ticket.status,beforeHandover.status);
ticket=await ok(action(ticket,f.peer,'ACCEPT_HANDOVER',{comment:'本人核对并接收'}));
assert.equal(ticket.assigneeId,f.peer);
await f.appoint(true);
ticket=await ok(action(ticket,f.peer,'REASSIGN',{targetGroupId:f.group,targetAssigneeId:f.owner,reason:'后续安排返回原工程师'}));
ticket=await ok(action(ticket,f.owner,'ACCEPT_HANDOVER',{comment:'正式任职后重新接收'}));
await f.appoint(false);
assert.equal((await detail()).canProcess,false,'leaving and returning to same owner cannot revive an old grant');
assert.equal((await detail()).continuations.find(item=>item.id===grant.id).current,false);
assert.equal(await sql(`SELECT row_to_json(s)::text FROM sla_cycles s WHERE ticket_id=${quote(ticket.id)}`),sla);
assert.equal(await sql(`SELECT count(*) FROM ticket_events e WHERE e.ticket_id=${quote(ticket.id)} AND NOT EXISTS
  (SELECT 1 FROM audit_logs a JOIN outbox_events o ON o.event_id=a.event_id WHERE a.event_id=e.id)`),'0');

// Approved exception never bypasses an inactive account or a withdrawn group membership.
ticket=await ok(action(ticket,f.owner,'CONTINUATION_PROPOSE',{reason:'最后验证窗口',dueAt:new Date(Date.now()+3600000).toISOString()}));
grant=(await detail()).continuations.find(item=>item.current&&item.status==='PENDING');
ticket=await ok(action(ticket,f.lead,'CONTINUATION_APPROVE',{continuationId:grant.id,reason:'独立复核'}));
await sql(`UPDATE employees SET active=false WHERE id=${quote(f.owner)}`);
assert.equal((await request(`/tickets/${ticket.id}`,f.owner)).status,401);
assert.equal(await sql(`SELECT ticket_processing_eligible(${quote(ticket.id)},${quote(f.owner)})`),'f');
await sql(`UPDATE employees SET active=true WHERE id=${quote(f.owner)};DELETE FROM group_memberships WHERE employee_id=${quote(f.owner)} AND group_id=${quote(f.group)}`);
assert.equal((await request(`/tickets/${ticket.id}`,f.owner)).status,404);
assert.equal(await sql(`SELECT ticket_processing_eligible(${quote(ticket.id)},${quote(f.owner)})`),'f');
console.log('Ticket continuity verified: immediate hold, independent scoped grant, expiry, revocation, supervisor-confirmed handover, epoch non-revival, membership boundaries and immutable SLA');
