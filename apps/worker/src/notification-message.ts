export function notificationLink(publicUrl: string, ticket: {
  ticket_id: string; number: string; action: string; to_status: string;
}) {
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:') throw new Error('HTTPS_DEEP_LINK_REQUIRED');
  const routingAlert = ticket.action === 'OWNERSHIP_ESCALATION_REQUIRED';
  const fulfillmentMessages:Record<string,string>={
    FULFILLMENT_REVIEW_REQUIRED:'交付待独立复核，请核查目标系统的实际授权。',
    FULFILLMENT_REVOKE_REQUIRED:'存在待回收授权，请在目标系统实际撤权后登记结果。',
    FULFILLMENT_REVIEW_OVERDUE:'交付尚未复核，已到提醒升级时间，请主管跟进。',
    FULFILLMENT_REVOKE_OVERDUE:'授权尚未回收，已到提醒升级时间，请主管跟进。',
  };
  const fulfillment=Object.hasOwn(fulfillmentMessages,ticket.action)?fulfillmentMessages[ticket.action]:undefined;
  base.hash = fulfillment ? '/fulfillments' : routingAlert ? '/routing-alerts' : `/tickets/${encodeURIComponent(ticket.ticket_id)}`;
  return {
    title: `${ticket.action.startsWith('P1_') ? 'P1 候选 · ' : 'IT 服务台 · '}${ticket.number}`,
    text: fulfillment ? `工单 ${ticket.number} ${fulfillment}` : ticket.action.startsWith('P1_')
      ? `${ticket.action === 'P1_REVIEW_OVERDUE' ? '主管确认逾期，请立即跟进。' : '请立即响应，主管确认中。'}工单 ${ticket.number}`
      : routingAlert ? `工单 ${ticket.number} 所属支持组无人可接，且无可用备用组，请检查路由告警。`
      : ticket.action === 'ASSIGN_OFFER' ? `工单 ${ticket.number} 待您确认接收，请在截止时间前处理。`
      : ticket.action === 'ASSIGNMENT_EXPIRED' ? `工单 ${ticket.number} 候选接收已超时，请调度员跟进。`
      : `工单 ${ticket.number} 状态已更新：${ticket.to_status}`,
    messageUrl: base.toString(),
    picUrl: '',
  };
}
