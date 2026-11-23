<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue';
import { Ban,Check,History,LoaderCircle,Plus,RefreshCw,Search,X } from 'lucide-vue-next';
import type { ManagedRoleCode,RoleBindingView,SessionUser } from '@itsm/contracts';
import { api,errorText } from '../api';
import { createRequestKey } from '../request-key';
import { formatDate } from '../labels';
import ContentBoundary from './ContentBoundary.vue';

const props=defineProps<{user:SessionUser}>();
type Options={groups:{id:string;name:string}[];people:{id:string;name:string;groups:string[]}[];hasMore:boolean;roleCodes:ManagedRoleCode[]};
type Audit={actorId:string|null;executionPrincipal?:string;authorityRef?:string;action:string;reason:string;createdAt:string};
const roles:Record<ManagedRoleCode,string>={PLATFORM_ADMIN:'平台管理员',DISPATCHER:'调度员',GROUP_LEAD:'支持组长'};
const states:Record<string,string>={PENDING:'待独立复核',ACTIVE:'已批准',REJECTED:'已拒绝',REVOKED:'已撤销'};
const events:Record<string,string>={PROPOSED:'提交提案',APPROVED:'批准',REJECTED:'拒绝',REVOKED:'撤销',BOOTSTRAPPED:'受控初始化',HANDED_OFF:'管理员交接',HANDOFF_REVOKED:'交接撤销演示权限'};
const items=ref<RoleBindingView[]>([]),options=ref<Options>({groups:[],people:[],hasMore:false,roleCodes:[]}),canReview=ref(false);
const busy=ref(false),loading=ref(true),error=ref(''),adding=ref(false),query=ref('');
const role=ref<ManagedRoleCode>('DISPATCHER'),group=ref(''),employee=ref(''),days=ref(30),reason=ref(''),safe=ref(false),proposalId=ref(createRequestKey());
const decision=ref<{item:RoleBindingView;action:'APPROVE'|'REJECT'|'REVOKE'}>(),decisionReason=ref(''),decisionSafe=ref(false);
const history=ref<{item:RoleBindingView;events:Audit[]}>();
let grantDates:{validFrom:string;validTo:string}|undefined;
const people=computed(()=>options.value.people.filter(person=>canReview.value||role.value==='PLATFORM_ADMIN'||person.groups.includes(group.value)));
watch([role,group],()=>{employee.value='';});
watch([role,group,employee,days,reason],()=>{safe.value=false;proposalId.value=createRequestKey();grantDates=undefined;});
watch(decisionReason,()=>{decisionSafe.value=false;});
async function load(){
  loading.value=true;error.value='';
  try{const result=await api<{items:RoleBindingView[];canReview:boolean}>('/admin/role-bindings');items.value=result.items;canReview.value=result.canReview;}
  catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
async function search(){
  busy.value=true;error.value='';
  try{options.value=await api<Options>(`/admin/role-bindings/options?q=${encodeURIComponent(query.value)}`);}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function openGrant(){adding.value=true;await search();}
async function propose(){
  if(busy.value||!safe.value||!employee.value)return;
  busy.value=true;error.value='';
  try{
    grantDates??={validFrom:new Date().toISOString(),validTo:new Date(Date.now()+days.value*86400000).toISOString()};
    await api(canReview.value?'/admin/role-bindings/apply':'/admin/role-bindings',{method:'POST',body:{id:proposalId.value,employeeId:employee.value,roleCode:role.value,
      groupId:role.value==='PLATFORM_ADMIN'?null:group.value,...grantDates,reason:reason.value,contentClass:'GENERAL'}});
    adding.value=false;employee.value='';reason.value='';await load();
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
function review(item:RoleBindingView,action:'APPROVE'|'REJECT'|'REVOKE'){
  decision.value={item,action};decisionReason.value='';decisionSafe.value=false;
}
async function decide(){
  if(!decision.value||busy.value||!decisionSafe.value)return;
  busy.value=true;error.value='';
  const current=decision.value;
  try{
    await api(`/admin/role-bindings/${current.item.id}/${current.action==='REVOKE'?'revoke':'review'}`,{method:'POST',body:{
      expectedVersion:current.item.version,reason:decisionReason.value,contentClass:'GENERAL',
      ...(current.action==='REVOKE'?{}:{decision:current.action})}});
    decision.value=undefined;await load();
  }catch(e){error.value=errorText(e);decision.value=undefined;await load();error.value=errorText(e);}
  finally{busy.value=false;}
}
async function showHistory(item:RoleBindingView){
  busy.value=true;error.value='';
  try{const result=await api<{items:Audit[]}>(`/admin/role-bindings/${item.id}/history`);history.value={item,events:result.items};}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
onMounted(load);
</script>

<template>
  <div class="roles-panel">
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div class="section-heading"><span class="muted">最近 200 条授权记录</span><div class="role-tools">
      <button class="icon-button" title="刷新角色授权" aria-label="刷新角色授权" :disabled="busy||loading" @click="load"><RefreshCw :size="17" :class="{spin:loading}"/></button>
      <button class="primary" :disabled="busy" @click="openGrant"><Plus :size="17"/>新增角色人员</button>
    </div></div>
    <section v-if="adding" class="detail-section" aria-label="新增角色授权">
      <div class="section-heading"><h2>新增角色人员</h2><button class="icon-button" title="收起" aria-label="收起" :disabled="busy" @click="adding=false"><X :size="17"/></button></div>
      <form class="request-form" @submit.prevent="propose">
        <div class="form-grid">
          <label>权限角色<select v-model="role" required><option v-for="code in options.roleCodes" :key="code" :value="code">{{roles[code]}}</option></select></label>
          <label v-if="role!=='PLATFORM_ADMIN'">支持组<select v-model="group" required><option value="">请选择</option><option v-for="item in options.groups" :key="item.id" :value="item.id">{{item.name}}</option></select></label>
          <label>人员查询<div class="role-search"><input v-model="query" type="search" maxlength="100"/><button type="button" class="icon-button" title="查询人员" aria-label="查询人员" :disabled="busy" @click="search"><Search :size="17"/></button></div></label>
          <label>授权人员<select v-model="employee" required><option value="">请选择</option><option v-for="person in people" :key="person.id" :value="person.id">{{person.name}} · {{person.id}}</option></select></label>
          <label>有效天数<input v-model.number="days" type="number" min="1" max="365" required/></label>
        </div>
        <p v-if="options.hasMore" class="muted" role="status">匹配超过 200 人，请缩小查询范围。</p>
        <label>授权原因<textarea v-model="reason" maxlength="1000" required rows="3"/></label>
        <ContentBoundary v-model="safe"/>
        <div class="form-footer"><button class="primary" type="submit" :disabled="busy||!safe||!employee||!reason.trim()"><LoaderCircle v-if="busy" class="spin" :size="16"/><Check v-else :size="16"/>{{canReview?'保存并生效':'提交独立复核'}}</button></div>
      </form>
    </section>
    <div v-if="loading" class="empty-state"><LoaderCircle class="spin" :size="26"/></div>
    <ul v-else class="role-list">
      <li v-for="item in items" :key="item.id" class="role-row" :aria-label="`${item.employeeName} ${roles[item.roleCode]}`">
        <div><strong>{{item.employeeName}}</strong><p class="mono muted">{{item.employeeId}}</p></div>
        <div><strong>{{roles[item.roleCode]}}</strong><p class="muted">{{item.groupName??'全局配置范围'}}</p></div>
        <div><span class="status">{{item.status==='ACTIVE'&&item.managementMode==='ADMIN_DIRECT'?'管理员配置':states[item.status]}}</span><p class="muted">{{item.effective?'当前生效':item.status==='ACTIVE'?'未生效 / 已到期 / 人员不可用':'未授权'}}</p></div>
        <div><time>{{formatDate(item.validTo)}}</time><p class="muted">{{item.reason}}</p></div>
        <div class="role-tools">
          <template v-if="canReview&&item.status==='PENDING'&&item.requestedBy!==user.id&&item.employeeId!==user.id">
            <button class="icon-button" title="批准授权" aria-label="批准授权" :disabled="busy" @click="review(item,'APPROVE')"><Check :size="17"/></button>
            <button class="icon-button" title="拒绝授权" aria-label="拒绝授权" :disabled="busy" @click="review(item,'REJECT')"><X :size="17"/></button>
          </template>
          <button v-if="canReview&&['PENDING','ACTIVE'].includes(item.status)" class="icon-button" title="撤销授权" aria-label="撤销授权" :disabled="busy" @click="review(item,'REVOKE')"><Ban :size="17"/></button>
          <button class="icon-button" title="授权审计" aria-label="授权审计" :disabled="busy" @click="showHistory(item)"><History :size="17"/></button>
        </div>
      </li>
    </ul>
    <p v-if="!loading&&!items.length" class="muted">暂无角色授权记录</p>
    <div v-if="decision" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="role-decision-title">
      <div class="section-heading"><h2 id="role-decision-title">{{decision.action==='APPROVE'?'批准授权':decision.action==='REJECT'?'拒绝授权':'撤销授权'}}</h2><button class="icon-button" title="关闭" aria-label="关闭" :disabled="busy" @click="decision=undefined"><X :size="17"/></button></div>
      <p>{{decision.item.employeeName}} · {{roles[decision.item.roleCode]}} · {{decision.item.groupName??'全局配置范围'}}</p>
      <p v-if="decision.action==='REVOKE'&&decision.item.employeeId===user.id" class="danger-text">正在撤销自己的授权，提交后对应管理权限将立即失效。</p>
      <form class="action-form" @submit.prevent="decide"><label>处理依据<textarea v-model="decisionReason" required maxlength="1000" rows="3"/></label><ContentBoundary v-model="decisionSafe"/><div class="form-footer"><button class="primary" :disabled="busy||!decisionSafe||!decisionReason.trim()"><Check :size="16"/>确认提交</button></div></form>
    </section></div>
    <div v-if="history" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="role-history-title">
      <div class="section-heading"><h2 id="role-history-title">授权审计</h2><button class="icon-button" title="关闭" aria-label="关闭" @click="history=undefined"><X :size="17"/></button></div>
      <p>{{history.item.employeeName}} · {{roles[history.item.roleCode]}}</p>
      <ol class="role-history"><li v-for="(event,index) in history.events" :key="index"><strong>{{events[event.action]??event.action}}</strong><p class="muted">{{event.actorId??event.executionPrincipal}} · {{formatDate(event.createdAt)}}</p><p v-if="event.authorityRef" class="muted">{{event.authorityRef}}</p><p>{{event.reason}}</p></li></ol>
    </section></div>
  </div>
</template>

<style scoped>
.role-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.role-list{list-style:none;margin:0;padding:0}.role-row{display:grid;grid-template-columns:minmax(110px,1fr) minmax(110px,1fr) minmax(105px,1fr) minmax(150px,1.4fr) auto;gap:18px;align-items:start;padding:20px 0;border-bottom:1px solid #dfe5e8}.role-row>div{min-width:0}.role-row p{font-size:12px;margin-top:5px;overflow-wrap:anywhere}.role-row strong{overflow-wrap:anywhere}.role-row time{font-size:12px}.role-search{display:flex;gap:8px;align-items:center}.role-search input{min-width:0}.role-search .icon-button{flex-shrink:0;margin-top:7px}.roles-panel>.detail-section{margin-top:24px}.role-history{padding-left:20px}.role-history li{padding:12px 0;border-bottom:1px solid #dfe5e8;overflow-wrap:anywhere}.role-history p{font-size:12px;margin-top:6px}@media(max-width:1100px){.role-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.role-row>.role-tools{grid-column:1/-1}}@media(max-width:760px){.role-row{gap:14px}.role-row p{font-size:11px}}
</style>
