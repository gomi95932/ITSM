export function notificationLink(publicUrl: string, ticket: {
  ticket_id: string; number: string; action: string; to_status: string;
}) {
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('HTTPS_DEEP_LINK_REQUIRED');
  const routingAlert = ticket.action === 'OWNERSHIP_ESCALATION_REQUIRED';
  const fulfillmentMessages:Record<string,string>={
    DELIVERY_FAILURE_REQUIRED:'交付登记未通过，请独立核查实际授权并登记处置结果。',
    DELIVERY_FAILURE_RESOLVED:'交付登记失败的独立核查结果已记录，请查看工作台。',
    FULFILLMENT_REVIEW_REQUIRED:'交付待独立复核，请核查目标系统的实际授权。',
    FULFILLMENT_REVOKE_REQUIRED:'存在待回收授权，请在目标系统实际撤权后登记结果。',
    FULFILLMENT_REVIEW_OVERDUE:'交付尚未复核，已到提醒升级时间，请主管跟进。',
    FULFILLMENT_REVOKE_OVERDUE:'授权尚未回收，已到提醒升级时间，请主管跟进。',
  };
  const fulfillment=Object.hasOwn(fulfillmentMessages,ticket.action)?fulfillmentMessages[ticket.action]:undefined;
  const waiting = ticket.action === 'WAITING_USER_FOLLOW_UP_DUE' ? '补充资料期限已到，请查看工单并跟进。'
    : ticket.action === 'WAITING_VENDOR_FOLLOW_UP_DUE' ? '厂商跟进期限已到，请查看工单并跟进。' : undefined;
  base.hash = fulfillment ? '/fulfillments' : routingAlert ? '/routing-alerts' : `/tickets/${encodeURIComponent(ticket.ticket_id)}`;
  if (base.toString().length > 500) throw new Error('HTTPS_DEEP_LINK_REQUIRED');
  return {
    title: `${ticket.action.startsWith('P1_') ? 'P1 候选 · ' : 'IT 服务台 · '}${ticket.number}`,
    text: waiting ? `工单 ${ticket.number} ${waiting}` : fulfillment ? `工单 ${ticket.number} ${fulfillment}` : ticket.action.startsWith('P1_')
      ? `${ticket.action === 'P1_REVIEW_OVERDUE' ? '主管确认逾期，请立即跟进。' : '请立即响应，主管确认中。'}工单 ${ticket.number}`
      : routingAlert ? `工单 ${ticket.number} 所属支持组无人可接，且无可用备用组，请检查路由告警。`
      : ticket.action === 'ASSIGN_OFFER' ? `工单 ${ticket.number} 待您确认接收，请在截止时间前处理。`
      : ticket.action === 'ASSIGNMENT_EXPIRED' ? `工单 ${ticket.number} 候选接收已超时，请调度员跟进。`
      : ticket.action === 'REQUEST_APPROVED' ? `工单 ${ticket.number} 审批已通过，等待工程师接单交付。`
      : ticket.action === 'REQUEST_REJECTED' ? `工单 ${ticket.number} 审批未通过，请查看申请记录。`
      : ticket.action === 'RESUME_VENDOR' ? `工单 ${ticket.number} 已恢复处理，请查看最新进度。`
      : `工单 ${ticket.number} 状态已更新：${ticket.to_status}`,
    messageUrl: base.toString(),
    picUrl: '',
  };
}

export function notificationMessage(publicUrl:string,ticket:Parameters<typeof notificationLink>[1]) {
  const link=notificationLink(publicUrl,ticket);
  const plain=(value:string)=>value.replace(/[\u0000-\u001f\u007f]/g,' ');
  const markdown=Array.from(plain(link.text),character=>'\\`*_{}[]()#+.!<>|~-'.includes(character)?`\\${character}`:character).join('');
  return {
    msgtype:'action_card' as const,
    action_card:{
      title:plain(link.title).slice(0,64),
      markdown,
      single_title:'查看并处理',
      single_url:link.messageUrl,
    },
  };
}
