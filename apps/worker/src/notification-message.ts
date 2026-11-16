export function notificationLink(publicUrl: string, ticket: {
  ticket_id: string; number: string; action: string; to_status: string;
}) {
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:') throw new Error('HTTPS_DEEP_LINK_REQUIRED');
  base.hash = `/tickets/${encodeURIComponent(ticket.ticket_id)}`;
  return {
    title: `${ticket.action.startsWith('P1_') ? 'P1 候选 · ' : 'IT 服务台 · '}${ticket.number}`,
    text: ticket.action.startsWith('P1_')
      ? `${ticket.action === 'P1_REVIEW_OVERDUE' ? '主管确认逾期，请立即跟进。' : '请立即响应，主管确认中。'}工单 ${ticket.number}`
      : ticket.action === 'ASSIGN_OFFER' ? `工单 ${ticket.number} 待您确认接收，请在截止时间前处理。`
      : ticket.action === 'ASSIGNMENT_EXPIRED' ? `工单 ${ticket.number} 候选接收已超时，请调度员跟进。`
      : `工单 ${ticket.number} 状态已更新：${ticket.to_status}`,
    messageUrl: base.toString(),
    picUrl: '',
  };
}
