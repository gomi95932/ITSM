<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { BarChart3, Search } from 'lucide-vue-next';
import type { SessionUser } from '@itsm/contracts';
import { api, errorText } from '../api';
import { formatDate, statuses } from '../labels';

const props = defineProps<{ user: SessionUser }>();
const emit = defineEmits<{ open: [id: string] }>();
const localToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const today = localToday();
const from = ref(new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10));
const to = ref(today), groupId = ref(props.user.groups[0] ?? '');
const groups = ref<{id:string;name:string}[]>([]), loading = ref(false), error = ref('');
type Item = { id:string;number:string;createdAt:string;status:string;priority:string;reopenCount:number;rating:number|null;
  firstResponse:{responded:boolean;minutes:number;target:number;overdue:boolean}|null;
  resolution:{completed:boolean;minutes:number;target:number;overdue:boolean}|null;overdueEver:boolean;unapprovedCalendar:boolean };
type Report = { metrics:{tickets:number;responded:number;firstResponseOverdue:number;resolved:number;resolutionOverdue:number;
  overdueTickets:number;reopenedTickets:number;rated:number;satisfactionAverage:number|null;unapprovedCalendarTickets:number}; items:Item[] };
const report = ref<Report>();

async function load() {
  if (!groupId.value) return;
  loading.value = true; error.value = '';
  try { report.value = await api<Report>(`/reports/summary?groupId=${encodeURIComponent(groupId.value)}&from=${from.value}&to=${to.value}`); }
  catch (e) { report.value = undefined; error.value = errorText(e); }
  finally { loading.value = false; }
}
onMounted(async () => {
  try {
    const response = await api<{items:{id:string;name:string}[]}>('/support-groups');
    groups.value = response.items.filter(g => props.user.groups.includes(g.id));
    await load();
  } catch (e) { error.value = errorText(e); }
});
const minutes = (value:number) => `${Math.round(value)} 分钟`;
</script>

<template>
  <div class="report-panel">
    <form class="report-filters" @submit.prevent="load">
      <label>支持组<select v-model="groupId"><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
      <label>开始日期<input v-model="from" type="date" required/></label>
      <label>结束日期<input v-model="to" type="date" required/></label>
      <button class="secondary" type="submit" :disabled="loading"><Search :size="16"/>查询</button>
    </form>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div v-if="report" :aria-busy="loading">
      <div class="report-metrics" aria-label="服务指标">
        <div><span>新增故障</span><strong>{{report.metrics.tickets}}</strong></div>
        <div><span>已首响</span><strong>{{report.metrics.responded}}</strong></div>
        <div><span>已解决</span><strong>{{report.metrics.resolved}}</strong></div>
        <div><span>超时工单</span><strong class="danger-text">{{report.metrics.overdueTickets}}</strong></div>
        <div><span>重开工单</span><strong>{{report.metrics.reopenedTickets}}</strong></div>
        <div><span>满意度</span><strong>{{report.metrics.satisfactionAverage ?? '—'}}<small v-if="report.metrics.rated"> / 5</small></strong></div>
      </div>
      <p class="report-note">按创建日期统计当前归属组的故障工单；转组后历史记录归入当前组。首响以员工消息确认送达为准，未送达不计首响；超时包含处理中及曾超时的周期。</p>
      <p v-if="report.metrics.unapprovedCalendarTickets" class="report-note amber-text">{{report.metrics.unapprovedCalendarTickets}} 条使用未批准的 SLA 日历，时效指标仅供试算。</p>
      <div class="table-wrap report-table"><table><thead><tr><th>工单</th><th>创建时间</th><th>状态</th><th>首响 / 目标</th><th>解决 / 目标</th><th>重开</th><th>评价</th></tr></thead>
        <tbody><tr v-for="item in report.items" :key="item.id"><td><button class="ticket-link" @click="emit('open',item.id)">{{item.number}}</button></td>
          <td>{{formatDate(item.createdAt)}}</td><td>{{statuses[item.status as keyof typeof statuses] ?? item.status}}</td>
          <td :class="{'danger-text':item.firstResponse?.overdue}">{{item.firstResponse ? `${item.firstResponse.responded?'已响':'待响'} · ${minutes(item.firstResponse.minutes)} / ${item.firstResponse.target}` : '—'}}</td>
          <td :class="{'danger-text':item.resolution?.overdue}">{{item.resolution ? `${item.resolution.completed?'已解决':'进行中'} · ${minutes(item.resolution.minutes)} / ${item.resolution.target}` : '—'}}</td>
          <td>{{item.reopenCount}}</td><td>{{item.rating ?? '—'}}</td></tr></tbody></table>
        <div v-if="!report.items.length" class="empty-state"><BarChart3 :size="28"/><p>该时段暂无故障工单</p></div>
      </div>
      <p class="report-note">首响超时 {{report.metrics.firstResponseOverdue}} 条 · 解决超时 {{report.metrics.resolutionOverdue}} 条 · 已评价 {{report.metrics.rated}} 条</p>
    </div>
  </div>
</template>

<style scoped>
.report-filters{display:flex;align-items:end;flex-wrap:wrap;gap:12px;margin-bottom:20px}.report-filters label{min-width:160px;flex:0 1 210px}.report-filters button{height:42px}
.report-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:1px solid #dfe5e8;border-bottom:1px solid #dfe5e8;background:#fff;padding:18px 0;gap:0}
.report-metrics>div{padding:0 16px;border-right:1px solid #e8edef;min-width:0}.report-metrics>div:last-child{border:0}.report-metrics span{display:block;color:#6b7d84;font-size:12px}.report-metrics strong{font-size:24px;line-height:1.4}.report-metrics small{font-size:12px}
.report-note{font-size:12px;color:#687981;margin:14px 0;line-height:1.6}.report-note.amber-text{color:#a2650b}.report-table{overflow:auto}.report-table table{min-width:760px}.report-table th,.report-table td{white-space:nowrap}
@media(max-width:1000px){.report-metrics{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:18px}.report-metrics>div:nth-child(3){border:0}}
@media(max-width:600px){.report-filters label{flex:1 1 135px;min-width:0}.report-filters label:first-child{flex-basis:100%}.report-metrics>div{padding:0 10px}.report-metrics strong{font-size:20px}}
</style>
