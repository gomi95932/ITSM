<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Bell, Search } from 'lucide-vue-next';
import type { SessionUser } from '@itsm/contracts';
import { api, errorText } from '../api';
import { formatDate } from '../labels';

const props = defineProps<{ user: SessionUser; groups: { id: string; name: string }[] }>();
const emit = defineEmits<{ open: [id: string] }>();
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const from = ref(new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10));
const to = ref(today), groupId = ref(props.user.groups[0] ?? ''), serviceType = ref('INC'), state = ref('ALL');
const loading = ref(false), error = ref('');
const stateLabels: Record<string, string> = { PENDING: '待发送', DISPATCHING: '正在提交', SENDING: '平台受理，待确认',
  DELIVERED: '平台确认发送成功', SIMULATED: '开发模拟', DEAD: '失败待处理', REVIEW_REQUIRED: '发送结果待核查',
  SKIPPED: '已跳过', OTHER: '未知状态' };
const reasonLabels: Record<string, string> = { LIVE_DELIVERY_DISABLED: '真实发送未启用', RECIPIENT_NOT_LINKED: '接收人未绑定钉钉',
  TOKEN_FAILED: '应用令牌获取失败', HTTPS_DEEP_LINK_REQUIRED: '消息链接未满足 HTTPS 要求', DINGTALK_NOT_CONFIGURED: '钉钉应用未配置',
  PROVIDER_UNAVAILABLE: '提供方暂不可用', DELIVERY_NOT_CONFIRMED: '未取得接收人发送确认',
  RECIPIENT_NO_LONGER_AUTHORIZED: '接收人资格已失效', DINGTALK_SEND_UNCONFIRMED: '发送结果不确定',
  PROVIDER_RECIPIENT_CHANGED: '接收人绑定已变更', LEGACY_DELIVERY_UNVERIFIED: '历史发送缺少可靠验证', OTHER: '其他原因，需受控核查' };
type Metrics = { deliveries: number; tickets: number; attention: number; states: Record<string, number>;
  reasons: { code: string; count: number }[] };
type Item = { id: string; ticketId: string; number: string; eventAt: string; updatedAt: string;
  state: string; attempts: number; reason: string | null };
type Report = { asOf: string; coverage: { events: number; unexpandedEvents: number; expandedWithoutDeliveryEvents: number };
  cohortMetrics: Metrics; metrics: Metrics; items: Item[] };
const report = ref<Report>();
function clearResult() { report.value = undefined; error.value = ''; }
async function load() {
  if (!groupId.value || loading.value) return;
  loading.value = true; error.value = '';
  try {
    const query = new URLSearchParams({ groupId: groupId.value, from: from.value, to: to.value,
      serviceType: serviceType.value, state: state.value });
    report.value = await api<Report>(`/reports/notifications?${query}`);
  } catch (e) { report.value = undefined; error.value = errorText(e); }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <section aria-label="通知健康统计">
    <form class="notice-report-filters" @submit.prevent="load">
      <label>支持组<select v-model="groupId" :disabled="loading" @change="clearResult"><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
      <label>工单类型<select v-model="serviceType" :disabled="loading" @change="clearResult"><option value="INC">故障工单</option><option value="REQ">服务请求</option></select></label>
      <label>事件开始日期<input v-model="from" type="date" required :disabled="loading" @change="clearResult"/></label>
      <label>事件结束日期<input v-model="to" type="date" required :disabled="loading" @change="clearResult"/></label>
      <label>投递状态<select v-model="state" :disabled="loading" @change="clearResult"><option value="ALL">全部状态</option><option value="ATTENTION">需要关注</option><option v-for="(label,code) in stateLabels" :key="code" :value="code">{{label}}</option></select></label>
      <button class="secondary" type="submit" :disabled="loading"><Search :size="16"/>查询</button>
    </form>
    <p v-if="loading" role="status">正在查询通知记录</p>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div v-if="report" :aria-busy="loading">
      <section aria-label="全部投递概况" class="notice-report-metrics">
        <div><span>投递记录</span><strong>{{report.cohortMetrics.deliveries}}</strong></div>
        <div><span>平台确认发送成功</span><strong>{{report.cohortMetrics.states.DELIVERED}}</strong></div>
        <div><span>需要关注</span><strong>{{report.cohortMetrics.attention}}</strong></div>
        <div><span>失败待处理</span><strong>{{report.cohortMetrics.states.DEAD}}</strong></div>
        <div><span>发送结果待核查</span><strong>{{report.cohortMetrics.states.REVIEW_REQUIRED}}</strong></div>
        <div><span>开发模拟</span><strong>{{report.cohortMetrics.states.SIMULATED}}</strong></div>
      </section>
      <p class="notice-report-note">按上海日期内产生的通知事件、工单当前责任组及当前投递状态统计；概况不受投递状态筛选影响。快照时间 {{formatDate(report.asOf)}}。模拟、跳过、平台受理均不算发送成功；发送成功不等于员工已读、接单或完成处理。</p>
      <p class="notice-report-note">通知事件 {{report.coverage.events}} 条 · 尚未展开 {{report.coverage.unexpandedEvents}} 条 · 已展开但无投递记录 {{report.coverage.expandedWithoutDeliveryEvents}} 条。无投递记录可能是无合格接收人或策略不发送，不能视为全部送达。</p>
      <section v-if="report.metrics.reasons.length" class="notice-report-reasons" aria-label="当前筛选原因分布">
        <h2>当前筛选原因分布</h2>
        <ul><li v-for="reason in report.metrics.reasons" :key="reason.code"><span>{{reasonLabels[reason.code]??reasonLabels.OTHER}}</span><strong>{{reason.count}}</strong></li></ul>
      </section>
      <p class="notice-report-note">当前筛选：{{report.metrics.deliveries}} 条投递，涉及 {{report.metrics.tickets}} 张工单。一次事件可有多条接收人投递，记录数不是独立工单数或失败尝试次数。</p>
      <div class="table-wrap notice-report-table"><table aria-label="通知投递统计明细"><thead><tr><th>工单</th><th>事件时间</th><th>当前状态</th><th>当前尝试周期次数</th><th>原因分类</th><th>最近更新</th></tr></thead>
        <tbody><tr v-for="item in report.items" :key="item.id"><td><button class="ticket-link" type="button" @click="emit('open',item.ticketId)">{{item.number}}</button></td>
          <td>{{formatDate(item.eventAt)}}</td><td>{{stateLabels[item.state]??stateLabels.OTHER}}</td><td>{{item.attempts}}</td>
          <td>{{item.reason===null?'无':reasonLabels[item.reason]??reasonLabels.OTHER}}</td><td>{{formatDate(item.updatedAt)}}</td></tr></tbody></table>
        <div v-if="!report.items.length" class="empty-state"><Bell :size="28"/><p>当前筛选条件下暂无投递记录</p></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.notice-report-filters{display:flex;align-items:end;flex-wrap:wrap;gap:12px;margin-bottom:20px}.notice-report-filters label{min-width:160px;flex:0 1 210px}.notice-report-filters button{height:42px}
.notice-report-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:1px solid #dfe5e8;border-bottom:1px solid #dfe5e8;background:#fff;padding:18px 0}
.notice-report-metrics>div{padding:0 16px;min-width:0;border-right:1px solid #e8edef}.notice-report-metrics>div:last-child{border:0}.notice-report-metrics span{display:block;color:#687981;font-size:12px}.notice-report-metrics strong{font-size:22px;overflow-wrap:anywhere}
.notice-report-note{font-size:12px;line-height:1.6;color:#687981;margin:14px 0}.notice-report-reasons h2{font-size:16px;margin:24px 0 12px}.notice-report-reasons ul{padding:0;margin:0;list-style:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.notice-report-reasons li{display:flex;gap:12px;justify-content:space-between;border-bottom:1px solid #e8edef;padding:10px 0}.notice-report-reasons li span{overflow-wrap:anywhere}
.notice-report-table{overflow:auto}.notice-report-table table{min-width:850px}.notice-report-table th,.notice-report-table td{white-space:nowrap}
@media(max-width:1000px){.notice-report-metrics{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:18px}.notice-report-metrics>div:nth-child(3){border:0}}
@media(max-width:600px){.notice-report-filters label{flex:1 1 135px;min-width:0}.notice-report-filters label:first-child{flex-basis:100%}.notice-report-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.notice-report-metrics>div{padding:0 10px}.notice-report-metrics>div:nth-child(3){border-right:1px solid #e8edef}.notice-report-metrics>div:nth-child(2n){border:0}.notice-report-reasons ul{grid-template-columns:minmax(0,1fr)}}
</style>
