import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationLink } from './notification-message.js';

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
