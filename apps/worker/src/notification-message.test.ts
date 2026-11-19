import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationLink } from './notification-message.js';

test('vendor resume announces public progress without disclosing the engineer explanation',()=>{
  const input={ticket_id:'vendor-1',number:'INC-0001',action:'RESUME_VENDOR',to_status:'IN_PROGRESS',
    detail:{comment:'private-explanation',vendorReference:'private-vendor'}};
  const message=notificationLink('https://itsm.example.test/',input);
  assert.equal(message.messageUrl,'https://itsm.example.test/#/tickets/vendor-1');
  assert.match(message.text,/已恢复处理/);
  assert.equal(JSON.stringify(message).includes('private-'),false);
  assert.throws(()=>notificationLink('http://itsm.example.test/',input),/HTTPS_DEEP_LINK_REQUIRED/);
});

test('waiting follow-ups identify the deadline without disclosing questions, vendor references or evidence',()=>{
  for(const action of ['WAITING_USER_FOLLOW_UP_DUE','WAITING_VENDOR_FOLLOW_UP_DUE']){
    const input={ticket_id:'waiting-1',number:'INC-0001',action,to_status:'WAITING_USER',
      detail:{question:'private-question',vendorReference:'private-vendor',reason:'private-reason'}};
    const message=notificationLink('https://itsm.example.test/',input);
    assert.equal(message.messageUrl,'https://itsm.example.test/#/tickets/waiting-1');
    assert.match(message.text,/期限已到/);
    assert.equal(JSON.stringify(message).includes('private-'),false);
    assert.throws(()=>notificationLink('http://itsm.example.test/',input),/HTTPS_DEEP_LINK_REQUIRED/);
  }
});

test('approval result messages distinguish approval from delivery and hide private bindings',()=>{
  for(const action of ['REQUEST_APPROVED','REQUEST_REJECTED']){
    const input={ticket_id:'request-1',number:'REQ-0001',action,
      to_status:action==='REQUEST_APPROVED'?'IN_PROGRESS':'REJECTED',detail:{approvalId:'private-approval',snapshot:'private-snapshot'}};
    const message=notificationLink('https://itsm.example.test/',input);
    assert.equal(message.messageUrl,'https://itsm.example.test/#/tickets/request-1');
    assert.match(message.text,action==='REQUEST_APPROVED'?/等待工程师接单交付/:/审批未通过/);
    assert.ok(!JSON.stringify(message).includes('private-'));
  }
});

test('fulfillment reminders link to authorized workspace without external evidence or approval details',()=>{
  for(const action of ['FULFILLMENT_REVIEW_REQUIRED','FULFILLMENT_REVOKE_REQUIRED','FULFILLMENT_REVIEW_OVERDUE','FULFILLMENT_REVOKE_OVERDUE','DELIVERY_FAILURE_REQUIRED','DELIVERY_FAILURE_RESOLVED']){
    const input={ticket_id:'ticket-f',number:'REQ-0001',action,to_status:'WAITING_APPROVAL',
      detail:{reference:'private-evidence',snapshot:'private-approval'}};
    const message=notificationLink('https://itsm.example.test/',input);
    assert.equal(message.messageUrl,'https://itsm.example.test/#/fulfillments');
    assert.match(message.text,/REQ-0001/);
    assert.ok(!JSON.stringify(message).includes('private-'));
    assert.throws(()=>notificationLink('http://itsm.example.test/',input),/HTTPS_DEEP_LINK_REQUIRED/);
  }
  for(const action of ['constructor','toString','__proto__'])
    assert.equal(notificationLink('https://itsm.example.test/',{ticket_id:'t',number:'REQ-1',action,to_status:'OPEN'}).messageUrl,
      'https://itsm.example.test/#/tickets/t');
});

test('DingTalk notification carries only an identifier, state and link', () => {
  const ticket = {
    ticket_id: 'ticket-1', number: 'INC-0001', action: 'REQUEST_INFO', to_status: 'WAITING_USER',
    detail: { comment: 'Sensitive evidence must remain inside the authorized ticket.' },
  };
  const message = notificationLink('https://itsm.example.test/', ticket);
  assert.equal(message.messageUrl, 'https://itsm.example.test/#/tickets/ticket-1');
  assert.equal(message.text, '工单 INC-0001 状态已更新：WAITING_USER');
  assert.ok(!JSON.stringify(message).includes(ticket.detail.comment));
  assert.throws(() => notificationLink('http://itsm.example.test/', ticket), /HTTPS_DEEP_LINK_REQUIRED/);
});

test('P1 reminders retain urgency without exposing ticket content', () => {
  const message = notificationLink('https://itsm.example.test/', {
    ticket_id: 'ticket-2', number: 'INC-0002', action: 'P1_REVIEW_OVERDUE', to_status: 'OPEN',
  });
  assert.match(message.text, /主管确认逾期/);
  assert.match(message.title, /^P1 候选/);
});

test('unroutable tickets link administrators to the alert list, not an inaccessible ticket', () => {
  const message = notificationLink('https://itsm.example.test/', {
    ticket_id:'ticket-3',number:'INC-0003',action:'OWNERSHIP_ESCALATION_REQUIRED',to_status:'QUEUED',
  });
  assert.equal(message.messageUrl,'https://itsm.example.test/#/routing-alerts');
  assert.match(message.text,/无人可接/);
});
