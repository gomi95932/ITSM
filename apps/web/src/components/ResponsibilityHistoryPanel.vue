<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { History, Search } from 'lucide-vue-next';
import type { SessionUser } from '@itsm/contracts';
import { api, errorText } from '../api';
import { statuses } from '../labels';

const props = defineProps<{ user: SessionUser; groups: { id: string; name: string }[] }>();
const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const from = ref(new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10));
const to = ref(today), groupId = ref(props.user.groups[0] ?? ''), serviceType = ref<'INC' | 'REQ'>('INC');
const selectedOwner = ref('ALL'), loading = ref(false), error = ref('');
type Metrics = { tickets: number; intervals: number; activeWallSeconds: number; unassignedWallSeconds: number;
  pendingAcceptanceWallSeconds: number; waitingUserWallSeconds: number; waitingVendorWallSeconds: number;
  waitingApprovalWallSeconds: number; awaitingConfirmationWallSeconds: number; legacyBaselineTickets: number;
  clockAdjustedIntervals: number };
type Owner = { employeeId: string | null; name: string | null; names: string[]; metrics: Metrics };
type Interval = { ticketId: string; number: string; revision: number; source: 'CREATED' | 'BASELINE' | 'CHANGE';
  recordedAt: string; from: string; until: string; elapsedSeconds: number; clockAdjusted: boolean;
  groupName: string; assigneeId: string | null; assigneeName: string | null; status: string;
  pendingAcceptance: boolean; serviceCode: string; serviceType: 'INC' | 'REQ';
  historyOrigin: 'CREATED' | 'BASELINE'; firstRecordedAt: string };
type Report = { asOf: string; recordingStartedAt: string; windowStartsBeforeRecording: boolean;
  responsibility: Owner[]; metrics: Metrics; items: Interval[] };
const report = ref<Report>(), owners = ref<Owner[]>([]);
const minutes = (seconds: number) => `${(seconds / 60).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 分钟`;
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' });
const formatObservation = (value: string) => dateTime.format(new Date(value));
function clearResult() { report.value = undefined; error.value = ''; }
function resetScope() { selectedOwner.value = 'ALL'; owners.value = []; clearResult(); }
async function load() {
  if (!groupId.value || loading.value) return;
  loading.value = true; error.value = '';
  const query = new URLSearchParams({ groupId: groupId.value, from: from.value, to: to.value, serviceType: serviceType.value });
  const person = selectedOwner.value.startsWith('PERSON:');
  query.set('ownerScope', person ? 'PERSON' : selectedOwner.value);
  if (person) query.set('employeeId', selectedOwner.value.slice(7));
  try { report.value = await api<Report>(`/reports/responsibility-history?${query}`); owners.value = report.value.responsibility; }
  catch (e) { report.value = undefined; error.value = errorText(e); }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <section aria-label="历史责任追溯">
    <form class="history-filters" @submit.prevent="load">
      <label>支持组<select v-model="groupId" :disabled="loading" @change="resetScope"><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
      <label>工单类型<select v-model="serviceType" :disabled="loading" @change="resetScope"><option value="INC">故障工单</option><option value="REQ">服务请求</option></select></label>
      <label>开始日期<input v-model="from" type="date" required :disabled="loading" @change="resetScope"/></label>
      <label>结束日期<input v-model="to" type="date" required :disabled="loading" @change="resetScope"/></label>
      <label>历史负责人<select v-model="selectedOwner" :disabled="loading" @change="clearResult">
        <option value="ALL">全部负责人</option><option value="UNASSIGNED">尚未接单</option>
        <option v-for="owner in owners.filter(o=>o.employeeId!==null)" :key="owner.employeeId??''" :value="`PERSON:${owner.employeeId}`">{{owner.name}}</option>
        <option v-if="selectedOwner.startsWith('PERSON:')&&!owners.some(o=>`PERSON:${o.employeeId}`===selectedOwner)" :value="selectedOwner">该人员无匹配记录</option>
      </select></label>
      <button class="secondary" type="submit" :disabled="loading"><Search :size="16"/>查询</button>
    </form>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div v-if="report" :aria-busy="loading">
      <div class="history-metrics">
        <div><span>期间涉及工单</span><strong>{{report.metrics.tickets}}</strong></div>
        <div><span>责任记录区间</span><strong>{{report.metrics.intervals}}</strong></div>
        <div><span>未结束归属时长</span><strong>{{minutes(report.metrics.activeWallSeconds)}}</strong></div>
        <div><span>其中尚未接单</span><strong>{{minutes(report.metrics.unassignedWallSeconds)}}</strong></div>
      </div>
      <p class="history-note">按上海日期内有重叠的历史区间统计，不限建单日期。归属时长含等待及待确认，不是工程师工时或 SLA 耗时。快照时间 <time :datetime="report.asOf">{{formatObservation(report.asOf)}}</time>。</p>
      <p v-if="report.windowStartsBeforeRecording||report.metrics.legacyBaselineTickets" class="history-note amber-text" role="status">
        历史记录始于 <time :datetime="report.recordingStartedAt">{{formatObservation(report.recordingStartedAt)}}</time>。迁移前的责任归属未知，不计入任何人员；存量工单仅从首次记录起统计。
      </p>
      <p v-if="report.metrics.clockAdjustedIntervals" class="history-note amber-text">{{report.metrics.clockAdjustedIntervals}} 个区间存在数据库时钟回拨修正，时长需结合原始运维记录复核。</p>
      <section v-if="report.responsibility.length" class="history-distribution" aria-label="历史责任分布">
        <h2>历史责任分布</h2>
        <div class="table-wrap history-table"><table><thead><tr><th>历史负责人</th><th>涉及工单</th><th>未结束归属时长</th><th>等待用户</th><th>等待外部</th><th>等待审批</th><th>待确认</th></tr></thead>
          <tbody><tr v-for="owner in report.responsibility" :key="owner.employeeId??'unassigned'">
            <td>{{owner.employeeId===null?'尚未接单':owner.name}}<small v-if="owner.names.length>1">记录名称：{{owner.names.join('、')}}</small></td>
            <td>{{owner.metrics.tickets}}</td><td>{{minutes(owner.metrics.activeWallSeconds)}}</td>
            <td>{{minutes(owner.metrics.waitingUserWallSeconds)}}</td><td>{{minutes(owner.metrics.waitingVendorWallSeconds)}}</td>
            <td>{{minutes(owner.metrics.waitingApprovalWallSeconds)}}</td><td>{{minutes(owner.metrics.awaitingConfirmationWallSeconds)}}</td>
          </tr></tbody></table></div>
      </section>
      <div class="table-wrap history-table"><table aria-label="历史责任区间"><thead><tr><th>工单</th><th>区间开始</th><th>区间结束</th><th>历史责任组</th><th>历史负责人</th><th>当时状态</th><th>区间时长</th><th>记录来源</th></tr></thead>
        <tbody><tr v-for="item in report.items" :key="`${item.ticketId}:${item.revision}`">
          <td>{{item.number}}<small>{{item.serviceCode}}</small></td><td><time :datetime="item.from">{{formatObservation(item.from)}}</time></td><td><time :datetime="item.until">{{formatObservation(item.until)}}</time></td>
          <td>{{item.groupName}}</td><td>{{item.assigneeName??'尚未接单'}}<small v-if="item.pendingAcceptance">存在待接收安排</small></td>
          <td>{{statuses[item.status as keyof typeof statuses]??item.status}}</td><td>{{minutes(item.elapsedSeconds)}}</td>
          <td>{{item.source==='BASELINE'?'存量基线':item.source==='CREATED'?'建单记录':'变更记录'}}<small v-if="item.historyOrigin==='BASELINE'">此前历史未知</small></td>
        </tr></tbody></table>
        <div v-if="!report.items.length" class="empty-state"><History :size="28"/><p>当前筛选条件下暂无已记录的责任区间</p></div>
      </div>
      <p class="history-note">姓名、责任组取自记录时快照；跨人员的涉及工单数不可相加去重。关闭、取消及拒绝后的区间不计入未结束归属时长。</p>
    </div>
  </section>
</template>

<style scoped>
.history-filters{display:flex;align-items:end;flex-wrap:wrap;gap:12px;margin-bottom:20px}.history-filters label{min-width:160px;flex:0 1 210px}.history-filters button{height:42px}
.history-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid #dfe5e8;border-bottom:1px solid #dfe5e8;padding:18px 0;background:#fff}
.history-metrics>div{padding:0 16px;min-width:0;border-right:1px solid #e8edef}.history-metrics>div:last-child{border:0}.history-metrics span{display:block;color:#6b7d84;font-size:12px}.history-metrics strong{display:block;font-size:20px;overflow-wrap:anywhere}
.history-note{font-size:12px;line-height:1.6;color:#687981;margin:14px 0}.history-note.amber-text{color:#a2650b}.history-distribution{margin:24px 0}.history-distribution h2{font-size:16px;margin:0}
.history-table{overflow:auto}.history-table table{min-width:1000px}.history-table th,.history-table td{white-space:nowrap}.history-table small{display:block;color:#687981}
@media(max-width:700px){.history-filters label{flex:1 1 135px;min-width:0}.history-filters label:first-child{flex-basis:100%}.history-metrics{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:18px}.history-metrics>div:nth-child(2){border:0}.history-metrics>div{padding:0 10px}}
</style>
