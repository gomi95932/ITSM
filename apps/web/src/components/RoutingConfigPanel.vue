<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue';
import { Check,History,LoaderCircle,Plus,RefreshCw,X } from 'lucide-vue-next';
import type { SessionUser } from '@itsm/contracts';
import { api,errorText } from '../api';
import { createRequestKey } from '../request-key';
import { formatDate } from '../labels';
import ContentBoundary from './ContentBoundary.vue';

type Group={id:string;name:string;fallbackGroupId:string|null;routingVersion:number};
type Policy={id:string;groupId:string;priority:string;receiveMinutes:number;calendar:{startHour:number;endHour:number;holidays:string[];workdays:string[]};validFrom:string;validTo:string;approvedBy:string};
type Proposal={id:string;kind:'ASSIGNMENT_POLICY'|'FALLBACK';groupId:string;priority:string|null;config:Record<string,unknown>;
  status:string;proposedBy:string;reviewedBy:string|null;reason:string;version:number;createdAt:string;reviewedAt:string|null};
type Audit={actorId:string;action:string;reason:string;createdAt:string;beforeValue:unknown;afterValue:unknown};
const props=defineProps<{user:SessionUser}>();
const groups=ref<Group[]>([]),policies=ref<Policy[]>([]),proposals=ref<Proposal[]>([]);
const busy=ref(false),loading=ref(true),error=ref(''),adding=ref(false);
const kind=ref<'ASSIGNMENT_POLICY'|'FALLBACK'>('ASSIGNMENT_POLICY'),groupId=ref(''),priority=ref('P3');
const enabled=ref(true),receiveMinutes=ref(60),startHour=ref(9),endHour=ref(18),validDays=ref(30);
const holidays=ref(''),workdays=ref(''),fallbackGroupId=ref(''),reason=ref(''),safe=ref(false);
const proposalId=ref(createRequestKey()),proposalDates=ref<{validFrom:string;validTo:string}>();
const decision=ref<{item:Proposal;action:'APPROVE'|'REJECT'}>(),decisionReason=ref(''),decisionSafe=ref(false);
const history=ref<{item:Proposal;events:Audit[]}>();
const active=computed(()=>policies.value.find(p=>p.groupId===groupId.value&&p.priority===priority.value));
const selected=computed(()=>groups.value.find(g=>g.id===groupId.value));
watch([kind,groupId,priority,enabled,receiveMinutes,startHour,endHour,validDays,holidays,workdays,fallbackGroupId,reason],()=>{
  safe.value=false;proposalId.value=createRequestKey();proposalDates.value=undefined;
});
watch(decisionReason,()=>decisionSafe.value=false);
watch(groupId,()=>{fallbackGroupId.value=selected.value?.fallbackGroupId??'';});
async function load(){
  loading.value=true;error.value='';
  try{
    const result=await api<{groups:Group[];policies:Policy[];proposals:Proposal[]}>('/admin/routing-config');
    groups.value=result.groups;policies.value=result.policies;proposals.value=result.proposals;
    if(!groups.value.some(g=>g.id===groupId.value))groupId.value=groups.value[0]?.id??'';
  }catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
function open(){adding.value=true;}
function config(){
  if(kind.value==='FALLBACK')return {fallbackGroupId:fallbackGroupId.value||null};
  if(!enabled.value)return {enabled:false};
  proposalDates.value??={validFrom:new Date().toISOString(),validTo:new Date(Date.now()+validDays.value*86400000).toISOString()};
  const dates=(v:string)=>v.split(',').map(s=>s.trim()).filter(Boolean);
  return {enabled:true,receiveMinutes:receiveMinutes.value,
    calendar:{timeZone:'Asia/Shanghai',startHour:startHour.value,endHour:endHour.value,
      holidays:dates(holidays.value),workdays:dates(workdays.value)},...proposalDates.value};
}
async function propose(){
  if(busy.value||!safe.value||!selected.value||!reason.value.trim())return;
  busy.value=true;error.value='';
  try{
    await api('/admin/routing-config',{method:'POST',body:{id:proposalId.value,kind:kind.value,groupId:groupId.value,
      ...(kind.value==='ASSIGNMENT_POLICY'?{priority:priority.value,expectedPolicyId:active.value?.id??null}
        :{expectedRoutingVersion:selected.value.routingVersion}),config:config(),reason:reason.value,contentClass:'GENERAL'}});
    adding.value=false;reason.value='';safe.value=false;proposalId.value=createRequestKey();proposalDates.value=undefined;await load();
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function review(){
  if(!decision.value||!decisionSafe.value||busy.value)return;
  const current=decision.value;busy.value=true;error.value='';
  try{
    await api(`/admin/routing-config/${current.item.id}/review`,{method:'POST',body:{decision:current.action,
      expectedVersion:current.item.version,reason:decisionReason.value,contentClass:'GENERAL'}});
    decision.value=undefined;await load();
  }catch(e){decision.value=undefined;await load();error.value=errorText(e);}finally{busy.value=false;}
}
async function showHistory(item:Proposal){
  busy.value=true;error.value='';
  try{const result=await api<{items:Audit[]}>(`/admin/routing-config/${item.id}/history`);history.value={item,events:result.items};}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
const label=(id:string)=>groups.value.find(g=>g.id===id)?.name??id;
onMounted(load);
</script>

<template>
  <div class="routing-config">
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div class="section-heading"><span class="muted">当前生效配置</span><div class="tools">
      <button class="icon-button" title="刷新路由配置" aria-label="刷新路由配置" :disabled="busy||loading" @click="load"><RefreshCw :size="17" :class="{spin:loading}"/></button>
      <button class="primary" :disabled="busy" @click="open"><Plus :size="17"/>配置提案</button>
    </div></div>
    <div v-if="loading" class="empty-state"><LoaderCircle class="spin" :size="26"/></div>
    <div v-else class="table-wrap"><table><thead><tr><th>支持组</th><th>备用路由</th><th>派人接收时限</th></tr></thead><tbody>
      <tr v-for="group in groups" :key="group.id"><td><strong>{{group.name}}</strong></td><td>{{group.fallbackGroupId?label(group.fallbackGroupId):'未配置'}}</td>
        <td><span v-for="policy in policies.filter(p=>p.groupId===group.id)" :key="policy.id" class="policy-chip" :title="`生效至 ${formatDate(policy.validTo)}`">{{policy.priority}} {{policy.receiveMinutes}} 分钟</span><span v-if="!policies.some(p=>p.groupId===group.id)" class="muted">未配置</span></td></tr>
    </tbody></table></div>
    <section v-if="adding" class="detail-section" aria-label="路由配置提案">
      <div class="section-heading"><h2>配置提案</h2><button class="icon-button" title="关闭" aria-label="关闭" :disabled="busy" @click="adding=false"><X :size="17"/></button></div>
      <form class="action-form" @submit.prevent="propose">
        <div class="segmented"><button type="button" :class="{selected:kind==='ASSIGNMENT_POLICY'}" @click="kind='ASSIGNMENT_POLICY'">接收时限</button><button type="button" :class="{selected:kind==='FALLBACK'}" @click="kind='FALLBACK'">备用路由</button></div>
        <label>支持组<select v-model="groupId" required><option v-for="g in groups" :key="g.id" :value="g.id">{{g.name}}</option></select></label>
        <template v-if="kind==='ASSIGNMENT_POLICY'">
          <label>优先级<select v-model="priority"><option v-for="p in ['P1','P2','P3','P4']" :key="p">{{p}}</option></select></label>
          <label class="check-label"><input v-model="enabled" type="checkbox"/>启用接收时限</label>
          <template v-if="enabled"><div class="config-grid">
            <label>接收分钟<input v-model.number="receiveMinutes" type="number" min="1" max="10080" required/></label>
            <label>开始时<input v-model.number="startHour" type="number" min="0" max="23" required/></label>
            <label>结束时<input v-model.number="endHour" type="number" min="1" max="24" required/></label>
            <label>有效天数<input v-model.number="validDays" type="number" min="1" max="366" required/></label>
          </div><label>假日（YYYY-MM-DD，逗号分隔）<input v-model="holidays" placeholder="可留空"/></label>
          <label>补班日（YYYY-MM-DD，逗号分隔）<input v-model="workdays" placeholder="可留空"/></label></template>
          <p v-if="active" class="muted">当前 {{active.receiveMinutes}} 分钟，至 {{formatDate(active.validTo)}}</p>
        </template>
        <template v-else><label>无成员时转至<select v-model="fallbackGroupId"><option value="">不设置备用组</option><option v-for="g in groups.filter(g=>g.id!==groupId)" :key="g.id" :value="g.id">{{g.name}}</option></select></label><p class="muted">当前：{{selected?.fallbackGroupId?label(selected.fallbackGroupId):'未配置'}}</p></template>
        <label>变更依据<textarea v-model="reason" required maxlength="500" rows="3"/></label><ContentBoundary v-model="safe"/>
        <div class="form-footer"><button class="primary" :disabled="busy||!safe||!reason.trim()||!groupId"><Check :size="16"/>提交独立复核</button></div>
      </form>
    </section>
    <section class="detail-section"><div class="section-heading"><h2>配置记录</h2><span class="muted">最近 200 条</span></div>
      <div class="table-wrap"><table><thead><tr><th>提交时间</th><th>配置范围</th><th>变更</th><th>状态</th><th>操作</th></tr></thead><tbody>
        <tr v-for="item in proposals" :key="item.id"><td>{{formatDate(item.createdAt)}}</td><td>{{label(item.groupId)}} {{item.priority??''}}</td>
          <td>{{item.kind==='FALLBACK'?`备用：${item.config.fallbackGroupId?label(String(item.config.fallbackGroupId)):'不设置'}`:item.config.enabled?`接收：${item.config.receiveMinutes} 分钟`:'停用接收时限'}}</td>
          <td><span class="status">{{{PENDING:'待复核',APPROVED:'已批准',REJECTED:'已拒绝'}[item.status]??item.status}}</span><small class="muted">{{item.proposedBy}}</small></td>
          <td><div class="tools"><template v-if="item.status==='PENDING'&&item.proposedBy!==props.user.id">
            <button class="icon-button" title="批准配置" aria-label="批准配置" :disabled="busy" @click="decision={item,action:'APPROVE'};decisionReason='';decisionSafe=false"><Check :size="17"/></button>
            <button class="icon-button" title="拒绝配置" aria-label="拒绝配置" :disabled="busy" @click="decision={item,action:'REJECT'};decisionReason='';decisionSafe=false"><X :size="17"/></button></template>
            <button class="icon-button" title="配置审计" aria-label="配置审计" :disabled="busy" @click="showHistory(item)"><History :size="17"/></button></div></td></tr>
      </tbody></table><p v-if="!proposals.length" class="empty-state">暂无配置记录</p></div>
    </section>
    <div v-if="decision" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="routing-review-title">
      <div class="section-heading"><h2 id="routing-review-title">{{decision.action==='APPROVE'?'批准配置':'拒绝配置'}}</h2><button class="icon-button" title="关闭" aria-label="关闭" :disabled="busy" @click="decision=undefined"><X :size="17"/></button></div>
      <p>{{label(decision.item.groupId)}} {{decision.item.priority??''}} · {{decision.item.reason}}</p>
      <form class="action-form" @submit.prevent="review"><label>复核依据<textarea v-model="decisionReason" required maxlength="500" rows="3"/></label><ContentBoundary v-model="decisionSafe"/><div class="form-footer"><button class="primary" :disabled="busy||!decisionSafe||!decisionReason.trim()"><Check :size="16"/>确认提交</button></div></form>
    </section></div>
    <div v-if="history" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="routing-history-title">
      <div class="section-heading"><h2 id="routing-history-title">配置审计</h2><button class="icon-button" title="关闭" aria-label="关闭" @click="history=undefined"><X :size="17"/></button></div>
      <p>{{label(history.item.groupId)}} {{history.item.priority??''}}</p><ol class="audit-list"><li v-for="(event,index) in history.events" :key="index"><strong>{{event.action}}</strong><small class="muted">{{event.actorId}} · {{formatDate(event.createdAt)}}</small><p>{{event.reason}}</p></li></ol>
    </section></div>
  </div>
</template>

<style scoped>
.tools{display:flex;align-items:center;gap:8px}.routing-config>.detail-section{margin-top:28px}.policy-chip{display:inline-block;margin-right:12px;white-space:nowrap}.config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.check-label{display:flex;align-items:center;gap:8px}.check-label input{width:auto}.audit-list{padding-left:20px}.audit-list li{padding:10px 0;border-bottom:1px solid #dfe5e8}.audit-list small{display:block}.routing-config td{overflow-wrap:anywhere}@media(max-width:700px){.config-grid{grid-template-columns:1fr}.routing-config table{min-width:620px}}
</style>
