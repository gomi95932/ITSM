import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_PRIORITY_POLICY,DEFAULT_CALENDAR,evaluatePriority,validPriorityPolicy,validPriorityEvidence,prioritySlaMeasurements} from '../../packages/contracts/dist/index.js';

test('matrix preserves legacy outcomes, critical interruption escalates only the configured service',()=>{
  assert.equal(validPriorityPolicy(DEFAULT_PRIORITY_POLICY),true);
  const p=structuredClone(DEFAULT_PRIORITY_POLICY);p.criticalServices=['INC-BIZ'];
  assert.equal(evaluatePriority(p,'INDIVIDUAL','LOW','INC-BIZ'),'P4');
  assert.equal(evaluatePriority(p,'INDIVIDUAL','HIGH','INC-BIZ'),'P1');
  assert.equal(evaluatePriority(p,'INDIVIDUAL','HIGH','INC-NET'),'P2');
  assert.equal(evaluatePriority(p,'DEPARTMENT','HIGH','INC-NET'),'P1');
});
test('policy rejects contradictory matrix, shorter low-priority targets, unknown fields and duplicate services',()=>{
  for(const edit of [p=>p.matrix.COMPANY.HIGH='P4',p=>p.targets.P1.response=31,
    p=>p.targets.P4.resolution=1,p=>p.reviewMinutes=0,p=>p.unexpected=true,
    p=>p.criticalServices=['INC-BIZ','INC-BIZ'],p=>p.targets.P1.response=NaN]){
    const p=structuredClone(DEFAULT_PRIORITY_POLICY);edit(p);assert.equal(validPriorityPolicy(p),false);
  }
});
test('AI evidence requires literal source quotes and leaves unknown facts empty',()=>{
  const text='Only my laptop is slow; work can continue.';
  const evidence={impact:'INDIVIDUAL',urgency:'LOW',impactQuote:'Only my laptop',urgencyQuote:'work can continue'};
  assert.equal(validPriorityEvidence(evidence,text),true);
  assert.equal(validPriorityEvidence({...evidence,impact:'COMPANY',impactQuote:'All production stopped'},text),false);
  assert.equal(validPriorityEvidence({...evidence,urgency:null,urgencyQuote:null},text),true);
  assert.equal(validPriorityEvidence({...evidence,priority:'P1'},text),false);
  assert.equal(validPriorityEvidence({...evidence,urgency:null},text),false);
});
const at=value=>new Date(`2026-11-23T${value}:00Z`);
const cycle=()=>({started_at:at('01:00'),responded_at:null,completed_at:null,paused_at:null,paused_minutes:0,
  priority:'P3',response_target:240,resolution_target:1080,calendar_snapshot:DEFAULT_CALENDAR,
  priority_obligations:[{id:'upgrade-1',priority:'P1',startedAt:at('01:30').toISOString(),responseTarget:15,resolutionTarget:240}],pause_history:[]});
test('escalation adds a strict clock without changing the original budget; downgrade cannot erase either',()=>{
  const c=cycle(),before=structuredClone(c);
  const [original,upgrade]=prioritySlaMeasurements(c,at('02:00'));
  assert.equal(original.responseMinutes,60);assert.equal(original.breached,false);
  assert.equal(upgrade.responseMinutes,30);assert.equal(upgrade.breached,true);
  assert.deepEqual(c,before);
  // Ticket current priority is separate from its immutable cycle and obligations.
  assert.equal(prioritySlaMeasurements(c,at('02:10'))[1].breached,true);
});
test('escalation clips completed and ongoing pauses, and an existing response satisfies the response target',()=>{
  const c=cycle();c.responded_at=at('01:10');c.paused_minutes=30;
  c.pause_history=[{from:at('01:20').toISOString(),to:at('01:50').toISOString()}];c.paused_at=at('02:00');
  const [original,upgrade]=prioritySlaMeasurements(c,at('02:20'));
  assert.equal(original.responseMinutes,10);assert.equal(upgrade.responseMinutes,0);
  assert.equal(original.resolutionMinutes,30);assert.equal(upgrade.resolutionMinutes,10);
});
test('P1 escalation continues over weekends and completed cycles freeze all clocks',()=>{
  const c=cycle();c.started_at=new Date('2026-11-20T09:00:00Z');c.responded_at=c.started_at;
  c.priority_obligations[0].startedAt='2026-11-21T00:00:00Z';
  c.completed_at=new Date('2026-11-21T05:00:00Z');
  const [original,upgrade]=prioritySlaMeasurements(c,new Date('2026-11-25T00:00:00Z'));
  assert.equal(original.resolutionMinutes,60);assert.equal(upgrade.resolutionMinutes,300);assert.equal(upgrade.breached,true);
});
