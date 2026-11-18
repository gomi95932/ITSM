<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { BarChart3, Bell, History, Search } from 'lucide-vue-next';
import type { SessionUser } from '@itsm/contracts';
import { api, errorText } from '../api';
import { formatDate, statuses } from '../labels';
import ResponsibilityHistoryPanel from './ResponsibilityHistoryPanel.vue';
import NotificationReportPanel from './NotificationReportPanel.vue';

const props = defineProps<{ user: SessionUser }>();
const emit = defineEmits<{ open: [id: string] }>();
const views = ['current','history','notifications'] as const;
const view = ref<typeof views[number]>('current');
const viewTabs = ref<HTMLDivElement>();
async function navigateViews(event: KeyboardEvent) {
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  view.value = event.key === 'Home' ? views[0] : event.key === 'End' ? views[views.length-1]
    : views[(views.indexOf(view.value)+(event.key==='ArrowRight'?1:views.length-1))%views.length];
  await nextTick();
  viewTabs.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
}
const localToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const today = localToday();
const from = ref(new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86400000).toISOString().slice(0, 10));
const to = ref(today), groupId = ref(props.user.groups[0] ?? '');
const serviceType = ref<'INC'|'REQ'>('INC');
const selectedOwner = ref('ALL');
const selectedService = ref('');
const groups = ref<{id:string;name:string}[]>([]), loading = ref(false), error = ref('');
type Item = { id:string;number:string;createdAt:string;status:string;priority:string;reopenCount:number;rating:number|null;
  serviceCode:string;serviceName:string;acceptedHandoverCount:number;
  assigneeId:string|null;assigneeName:string|null;assigneeActive:boolean|null;
  pendingAssigneeId:string|null;pendingAssigneeName:string|null;assignmentKind:'OFFER'|'HANDOVER'|null;
  firstResponse:{responded:boolean;minutes:number;target:number;overdue:boolean}|null;
  resolution:{completed:boolean;minutes:number;target:number;overdue:boolean}|null;overdueEver:boolean;unapprovedCalendar:boolean };
type Metrics = {tickets:number;active:number;pendingAcceptance:number;waitingUser:number;waitingVendor:number;awaitingConfirmation:number;
  acceptedHandovers:number;
  responded:number;firstResponseOverdue:number;resolved:number;resolutionOverdue:number;overdueTickets:number;reopenedTickets:number;
  rated:number;satisfactionAverage:number|null;unapprovedCalendarTickets:number};
type Responsibility = {employeeId:string|null;name:string|null;active:boolean|null;metrics:Metrics};
type Service = {serviceCode:string;name:string;metrics:Metrics};
type Report = { serviceType:'INC'|'REQ';asOf:string;ownerFilter:{ownerScope:'ALL'|'UNASSIGNED'|'PERSON';employeeId:string|null};
  responsibility:Responsibility[];services:Service[];metrics:Metrics;items:Item[] };
const report = ref<Report>();
const owners = ref<Responsibility[]>([]);
const services = ref<Service[]>([]);

function clearResult() { report.value=undefined; error.value=''; }
function resetService() { selectedService.value=''; services.value=[]; clearResult(); }
function resetScope() { selectedOwner.value='ALL'; owners.value=[]; resetService(); }

async function load() {
  if (!groupId.value || loading.value) return;
  loading.value = true; error.value = '';
  const query = new URLSearchParams({ groupId:groupId.value, from:from.value, to:to.value, serviceType:serviceType.value });
  const person=selectedOwner.value.startsWith('PERSON:');
  query.set('ownerScope',person?'PERSON':selectedOwner.value);
  if(person)query.set('employeeId',selectedOwner.value.slice(7));
  if(selectedService.value)query.set('serviceCode',selectedService.value);
  try { report.value = await api<Report>(`/reports/summary?${query}`); owners.value=report.value.responsibility; services.value=report.value.services; }
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
const completion = (item:Item, type:Report['serviceType']) => item.resolution?.completed
  ? type === 'REQ' ? '已交付' : '已解决'
  : ['REJECTED','CANCELLED'].includes(item.status) ? '已终止' : '进行中';
</script>

<template>
  <div class="report-panel">
    <div ref="viewTabs" class="report-views" role="tablist" aria-label="报表视图" @keydown="navigateViews">
      <button id="report-current-tab" type="button" role="tab" :tabindex="view==='current'?0:-1" :aria-selected="view==='current'" aria-controls="report-current" @click="view='current'"><BarChart3 :size="16"/>当前责任</button>
      <button id="report-history-tab" type="button" role="tab" :tabindex="view==='history'?0:-1" :aria-selected="view==='history'" aria-controls="report-history" @click="view='history'"><History :size="16"/>历史责任</button>
      <button id="report-notifications-tab" type="button" role="tab" :tabindex="view==='notifications'?0:-1" :aria-selected="view==='notifications'" aria-controls="report-notifications" @click="view='notifications'"><Bell :size="16"/>通知健康</button>
    </div>
    <div v-if="view==='current'" id="report-current" role="tabpanel" tabindex="0" aria-labelledby="report-current-tab">
    <form class="report-filters" @submit.prevent="load">
      <label>支持组<select v-model="groupId" :disabled="loading" @change="resetScope"><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
      <label>工单类型<select v-model="serviceType" :disabled="loading" @change="resetScope"><option value="INC">故障工单</option><option value="REQ">服务请求</option></select></label>
      <label>开始日期<input v-model="from" type="date" required :disabled="loading" @change="resetScope"/></label>
      <label>结束日期<input v-model="to" type="date" required :disabled="loading" @change="resetScope"/></label>
      <label>当前负责人<select v-model="selectedOwner" :disabled="loading" @change="resetService">
        <option value="ALL">全部负责人</option><option value="UNASSIGNED">尚未接单</option>
        <option v-for="owner in owners.filter(o=>o.employeeId!==null)" :key="owner.employeeId??''" :value="`PERSON:${owner.employeeId}`">{{owner.name}}{{owner.active===false?'（已停用）':''}}</option>
        <option v-if="selectedOwner.startsWith('PERSON:')&&!owners.some(o=>`PERSON:${o.employeeId}`===selectedOwner)" :value="selectedOwner">该人员当前无工单</option>
      </select></label>
      <label>服务目录<select v-model="selectedService" :disabled="loading" @change="clearResult">
        <option value="">全部服务</option>
        <option v-for="service in services" :key="service.serviceCode" :value="service.serviceCode">{{service.name}} · {{service.serviceCode}}</option>
        <option v-if="selectedService&&!services.some(s=>s.serviceCode===selectedService)" :value="selectedService">该服务当前无工单</option>
      </select></label>
      <button class="secondary" type="submit" :disabled="loading"><Search :size="16"/>查询</button>
    </form>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div v-if="report" :aria-busy="loading">
      <div class="report-metrics" aria-label="服务指标">
        <div><span>{{report.serviceType === 'REQ' ? '新增请求' : '新增故障'}}</span><strong>{{report.metrics.tickets}}</strong></div>
        <div><span>已首响</span><strong>{{report.metrics.responded}}</strong></div>
        <div><span>{{report.serviceType === 'REQ' ? '已交付' : '已解决'}}</span><strong>{{report.metrics.resolved}}</strong></div>
        <div><span>超时工单</span><strong class="danger-text">{{report.metrics.overdueTickets}}</strong></div>
        <div><span>重开工单</span><strong>{{report.metrics.reopenedTickets}}</strong></div>
        <div><span>满意度</span><strong>{{report.metrics.satisfactionAverage ?? '—'}}<small v-if="report.metrics.rated"> / 5</small></strong></div>
      </div>
      <p class="report-note">按创建日期统计当前归属组的{{report.serviceType === 'REQ' ? '服务请求' : '故障工单'}}；指标与明细按所选当前负责人及服务筛选。转组或换人后随当前归属变化，不代表历史责任或绩效；超时仍按整单 SLA 计算。快照时间 {{formatDate(report.asOf)}}。</p>
      <p class="report-note">首响以员工消息确认送达为准，未送达不计首响；超时包含处理中及曾超时的周期。</p>
      <p v-if="report.metrics.unapprovedCalendarTickets" class="report-note amber-text">{{report.metrics.unapprovedCalendarTickets}} 条使用未批准的 SLA 日历，时效指标仅供试算。</p>
      <section v-if="report.responsibility.length" class="responsibility-section" aria-label="当前责任分布">
        <h2>当前责任分布</h2>
        <p class="report-note">本组所选日期与类型的全部工单；未结束含待确认，待接收尚未转移责任。姓名为当前人员档案名称。</p>
        <div class="table-wrap report-table"><table><thead><tr><th>当前负责人</th><th>工单数</th><th>未结束</th><th>待接收</th><th>等待用户</th><th>等待外部</th><th>待确认</th><th>整单曾超时</th></tr></thead>
          <tbody><tr v-for="owner in report.responsibility" :key="owner.employeeId??'unassigned'">
            <td>{{owner.employeeId===null?'尚未接单':owner.name}}<span v-if="owner.active===false" class="owner-warning">已停用</span></td>
            <td>{{owner.metrics.tickets}}</td><td>{{owner.metrics.active}}</td><td>{{owner.metrics.pendingAcceptance}}</td>
            <td>{{owner.metrics.waitingUser}}</td><td>{{owner.metrics.waitingVendor}}</td><td>{{owner.metrics.awaitingConfirmation}}</td>
            <td :class="{'danger-text':owner.metrics.overdueTickets}">{{owner.metrics.overdueTickets}}</td>
          </tr></tbody></table></div>
      </section>
      <section v-if="report.services.length" class="responsibility-section" aria-label="服务维度统计">
        <h2>服务维度统计</h2>
        <p class="report-note">所选负责人下的全部服务，名称为当前目录名称。交接仅统计这些工单已有记录的本组接收事件，不含发起、拒收、撤回或其他组接收。</p>
        <div class="table-wrap report-table"><table aria-label="服务指标汇总"><thead><tr><th>服务</th><th>工单数</th><th>未结束</th><th>待接收</th><th>本组已接收交接</th><th>已首响</th><th>{{report.serviceType==='REQ'?'已交付':'已解决'}}</th><th>整单曾超时</th><th>重开工单</th><th>满意度</th></tr></thead>
          <tbody><tr v-for="service in report.services" :key="service.serviceCode">
            <td class="service-name">{{service.name}}<small>{{service.serviceCode}}</small></td><td>{{service.metrics.tickets}}</td><td>{{service.metrics.active}}</td>
            <td>{{service.metrics.pendingAcceptance}}</td><td>{{service.metrics.acceptedHandovers}}</td><td>{{service.metrics.responded}}</td><td>{{service.metrics.resolved}}</td>
            <td :class="{'danger-text':service.metrics.overdueTickets}">{{service.metrics.overdueTickets}}</td><td>{{service.metrics.reopenedTickets}}</td><td>{{service.metrics.satisfactionAverage??'—'}}</td>
          </tr></tbody></table></div>
      </section>
      <div class="table-wrap report-table"><table aria-label="工单指标明细"><thead><tr><th>工单</th><th>服务</th><th>创建时间</th><th>状态</th><th>当前责任</th><th>首响 / 目标</th><th>{{report.serviceType === 'REQ' ? '交付 / 目标' : '解决 / 目标'}}</th><th>本组已接收交接</th><th>重开</th><th>评价</th></tr></thead>
        <tbody><tr v-for="item in report.items" :key="item.id"><td><button class="ticket-link" @click="emit('open',item.id)">{{item.number}}</button></td>
          <td class="service-name">{{item.serviceName}}<small>{{item.serviceCode}}</small></td>
          <td>{{formatDate(item.createdAt)}}</td><td>{{statuses[item.status as keyof typeof statuses] ?? item.status}}</td>
          <td>{{item.assigneeName??'尚未接单'}}<span v-if="item.assigneeActive===false" class="owner-warning">已停用</span>
            <small v-if="item.pendingAssigneeId" class="pending-owner">{{item.assignmentKind==='HANDOVER'?'交接待接收':'派单待接收'}}：{{item.pendingAssigneeName}}</small></td>
          <td :class="{'danger-text':item.firstResponse?.overdue}">{{item.firstResponse ? `${item.firstResponse.responded?'已响':'待响'} · ${minutes(item.firstResponse.minutes)} / ${item.firstResponse.target}` : '—'}}</td>
          <td :class="{'danger-text':item.resolution?.overdue}">{{item.resolution ? `${completion(item,report.serviceType)} · ${minutes(item.resolution.minutes)} / ${item.resolution.target}` : '—'}}</td>
          <td>{{item.acceptedHandoverCount}}</td><td>{{item.reopenCount}}</td><td>{{item.rating ?? '—'}}</td></tr></tbody></table>
        <div v-if="!report.items.length" class="empty-state"><BarChart3 :size="28"/><p>当前筛选条件下暂无{{report.serviceType === 'REQ' ? '服务请求' : '故障工单'}}</p></div>
      </div>
      <p class="report-note">首响超时 {{report.metrics.firstResponseOverdue}} 条 · {{report.serviceType === 'REQ' ? '交付超时' : '解决超时'}} {{report.metrics.resolutionOverdue}} 条 · 已评价 {{report.metrics.rated}} 条 · 本组已接收交接 {{report.metrics.acceptedHandovers}} 次</p>
    </div>
    </div>
    <div v-else-if="view==='history'" id="report-history" role="tabpanel" tabindex="0" aria-labelledby="report-history-tab"><ResponsibilityHistoryPanel :user="user" :groups="groups"/></div>
    <div v-else id="report-notifications" role="tabpanel" tabindex="0" aria-labelledby="report-notifications-tab"><NotificationReportPanel :user="user" :groups="groups" @open="emit('open',$event)"/></div>
  </div>
</template>

<style scoped>
.report-views{display:flex;flex-wrap:wrap;gap:16px;border-bottom:1px solid #dfe5e8;margin-bottom:20px}.report-views button{display:flex;align-items:center;gap:6px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:#687981;padding:10px 2px;min-height:44px}.report-views button[aria-selected=true]{color:#087e79;border-bottom-color:#087e79}
.report-filters{display:flex;align-items:end;flex-wrap:wrap;gap:12px;margin-bottom:20px}.report-filters label{min-width:160px;flex:0 1 210px}.report-filters button{height:42px}
.report-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-top:1px solid #dfe5e8;border-bottom:1px solid #dfe5e8;background:#fff;padding:18px 0;gap:0}
.report-metrics>div{padding:0 16px;border-right:1px solid #e8edef;min-width:0}.report-metrics>div:last-child{border:0}.report-metrics span{display:block;color:#6b7d84;font-size:12px}.report-metrics strong{font-size:24px;line-height:1.4}.report-metrics small{font-size:12px}
.report-note{font-size:12px;color:#687981;margin:14px 0;line-height:1.6}.report-note.amber-text{color:#a2650b}.report-table{overflow:auto}.report-table table{min-width:760px}.report-table th,.report-table td{white-space:nowrap}
.responsibility-section{margin:24px 0}.responsibility-section h2{font-size:16px;margin:0}.pending-owner{display:block;color:#687981}.owner-warning{display:inline-block;margin-left:8px;color:#a2650b;font-size:12px}
.report-table .service-name{white-space:normal;min-width:180px;max-width:280px;overflow-wrap:anywhere}.service-name small{display:block;color:#687981}
@media(max-width:1000px){.report-metrics{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:18px}.report-metrics>div:nth-child(3){border:0}}
@media(max-width:600px){.report-filters label{flex:1 1 135px;min-width:0}.report-filters label:first-child{flex-basis:100%}.report-metrics>div{padding:0 10px}.report-metrics strong{font-size:20px}}
</style>
