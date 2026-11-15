<script setup lang="ts">
import { onMounted,ref,watch } from 'vue';
import { Check,History,LoaderCircle,Pencil,Plus,RefreshCw,Search,UserMinus,UserPlus,X } from 'lucide-vue-next';
import type { MembershipChangeView,SessionUser,SupportGroupMemberView,SupportGroupView } from '@itsm/contracts';
import { api,errorText } from '../api';
import { createRequestKey } from '../request-key';
import { formatDate } from '../labels';
import ContentBoundary from './ContentBoundary.vue';

const props=defineProps<{user:SessionUser}>();
type Group={id:string;name:string;version:number};
type Detail={group:Group;members:SupportGroupMemberView[];changes:MembershipChangeView[];canConfigure:boolean;canReview:boolean};
type Audit={action:string;actorId:string;reason:string;createdAt:string};
type Dialog={mode:'CREATE'|'RENAME'|'ADD'|'REMOVE'|'REVIEW';employeeId?:string;employeeName?:string;change?:MembershipChangeView;decision?:'APPROVE'|'REJECT'};
const groups=ref<SupportGroupView[]>([]),selected=ref(''),detail=ref<Detail>(),canConfigure=ref(false);
const loading=ref(false),busy=ref(false),error=ref(''),dialog=ref<Dialog>(),history=ref<Audit[]>();
const groupId=ref(''),groupName=ref(''),reason=ref(''),safe=ref(false),employeeId=ref(''),query=ref('');
const people=ref<{id:string;name:string}[]>([]),hasMore=ref(false),proposalId=ref(createRequestKey());
const statusLabels={PENDING:'待独立复核',APPROVED:'已批准',REJECTED:'已拒绝'};
const auditLabels:Record<string,string>={CREATED:'创建支持组',RENAMED:'修改名称',MEMBER_PROPOSED:'提交成员变更',MEMBER_APPROVED:'批准成员变更',MEMBER_REJECTED:'拒绝成员变更'};
let generation=0;
watch([groupId,groupName,reason,employeeId],()=>{safe.value=false;proposalId.value=createRequestKey();});
async function load(){
  loading.value=true;error.value='';
  try{
    const result=await api<{items:SupportGroupView[];canConfigure:boolean}>('/admin/support-groups');
    groups.value=result.items;canConfigure.value=result.canConfigure;
    if(!groups.value.some(g=>g.id===selected.value))selected.value=groups.value[0]?.id??'';
    await loadDetail();
  }catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
async function loadDetail(){
  const current=++generation,id=selected.value;detail.value=undefined;
  if(!id)return;
  try{const result=await api<Detail>(`/admin/support-groups/${encodeURIComponent(id)}`);if(current===generation)detail.value=result;}
  catch(e){if(current===generation)error.value=errorText(e);}
}
function open(value:Dialog){
  dialog.value=value;reason.value='';safe.value=false;people.value=[];query.value='';employeeId.value='';hasMore.value=false;
  groupId.value='';groupName.value=value.mode==='RENAME'?detail.value?.group.name??'':'';proposalId.value=createRequestKey();
}
async function search(){
  if(busy.value||query.value.trim().length<2)return;
  busy.value=true;error.value='';employeeId.value='';
  try{const result=await api<{items:{id:string;name:string}[];hasMore:boolean}>(`/admin/support-groups/people?q=${encodeURIComponent(query.value)}`);people.value=result.items;hasMore.value=result.hasMore;}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function submit(){
  const current=dialog.value;if(!current||busy.value||!safe.value)return;
  busy.value=true;error.value='';
  const content={reason:reason.value,contentClass:'GENERAL'};
  try{
    if(current.mode==='CREATE'){
      await api('/admin/support-groups',{method:'POST',body:{id:groupId.value,name:groupName.value,...content}});selected.value=groupId.value;
    }else if(current.mode==='RENAME'){
      await api(`/admin/support-groups/${encodeURIComponent(selected.value)}`,{method:'PATCH',body:{name:groupName.value,expectedVersion:detail.value!.group.version,...content}});
    }else if(current.mode==='REVIEW'){
      await api(`/admin/support-groups/${encodeURIComponent(selected.value)}/members/${current.change!.id}/review`,{method:'POST',body:{expectedVersion:current.change!.version,decision:current.decision,...content}});
    }else{
      await api(`/admin/support-groups/${encodeURIComponent(selected.value)}/members`,{method:'POST',body:{id:proposalId.value,
        employeeId:current.mode==='ADD'?employeeId.value:current.employeeId,operation:current.mode,expectedGroupVersion:detail.value!.group.version,...content}});
    }
    dialog.value=undefined;await load();
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function showHistory(){
  busy.value=true;error.value='';
  try{history.value=(await api<{items:Audit[]}>(`/admin/support-groups/${encodeURIComponent(selected.value)}/history`)).items;}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
onMounted(load);
</script>

<template>
  <div class="groups-panel">
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div class="section-heading group-tools"><label class="group-picker">支持组<select v-model="selected" :disabled="busy||loading" @change="loadDetail"><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}} · {{group.activeMembers}} 人</option></select></label><div class="group-tools">
      <button class="icon-button" title="刷新支持组" aria-label="刷新支持组" :disabled="busy||loading" @click="load"><RefreshCw :size="17" :class="{spin:loading}"/></button>
      <button v-if="canConfigure" class="primary" :disabled="busy||loading" @click="open({mode:'CREATE'})"><Plus :size="17"/>新建支持组</button>
    </div></div>
    <div v-if="loading" class="empty-state"><LoaderCircle class="spin" :size="26"/></div>
    <template v-else-if="detail">
      <div class="section-heading group-heading"><div><h2>{{detail.group.name}}</h2><p class="muted mono">{{detail.group.id}} · v{{detail.group.version}}</p></div><div class="group-tools">
        <button v-if="detail.canConfigure" class="icon-button" title="修改组名" aria-label="修改组名" :disabled="busy" @click="open({mode:'RENAME'})"><Pencil :size="17"/></button>
        <button class="icon-button" title="支持组审计" aria-label="支持组审计" :disabled="busy" @click="showHistory"><History :size="17"/></button>
        <button class="primary" :disabled="busy" @click="open({mode:'ADD'})"><UserPlus :size="17"/>添加成员</button>
      </div></div>
      <ul class="member-list" aria-label="支持组成员"><li v-for="member in detail.members" :key="member.id" :aria-label="`成员 ${member.name}`">
        <div><strong>{{member.name}}</strong><p class="muted mono">{{member.id}}</p></div>
        <div><span class="status">{{member.active?'在职':'已停用'}}</span><p class="muted">{{member.roles.map(r=>r==='GROUP_LEAD'?'支持组长':r==='DISPATCHER'?'调度员':r).join(' · ')||'工程师'}}</p></div>
        <button v-if="member.id!==user.id" class="icon-button" title="移除成员提案" aria-label="移除成员提案" :disabled="busy" @click="open({mode:'REMOVE',employeeId:member.id,employeeName:member.name})"><UserMinus :size="17"/></button>
      </li></ul>
      <p v-if="!detail.members.length" class="muted">暂无成员</p>
      <section class="group-changes"><h2>成员变更</h2><ul class="change-list" aria-label="成员变更记录"><li v-for="change in detail.changes" :key="change.id" :aria-label="`${change.employeeName} ${change.operation==='ADD'?'加入':'移除'}`">
        <div><strong>{{change.employeeName}}</strong><p class="muted">{{change.operation==='ADD'?'加入支持组':'移除支持组'}} · {{formatDate(change.createdAt)}}</p></div>
        <div><span class="status">{{statusLabels[change.status]}}</span><p>{{change.reason}}</p><p v-if="change.reviewReason" class="muted">{{change.reviewReason}}</p></div>
        <div v-if="detail.canReview&&change.status==='PENDING'&&change.requestedBy!==user.id&&change.employeeId!==user.id" class="group-tools">
          <button class="icon-button" title="批准成员变更" aria-label="批准成员变更" :disabled="busy" @click="open({mode:'REVIEW',change,decision:'APPROVE'})"><Check :size="17"/></button>
          <button class="icon-button" title="拒绝成员变更" aria-label="拒绝成员变更" :disabled="busy" @click="open({mode:'REVIEW',change,decision:'REJECT'})"><X :size="17"/></button>
        </div>
      </li></ul><p v-if="!detail.changes.length" class="muted">暂无成员变更记录</p></section>
    </template>
    <p v-else-if="!loading" class="muted">暂无可管理的支持组</p>
    <div v-if="dialog" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="group-dialog-title">
      <div class="section-heading"><h2 id="group-dialog-title">{{dialog.mode==='CREATE'?'新建支持组':dialog.mode==='RENAME'?'修改组名':dialog.mode==='ADD'?'添加成员提案':dialog.mode==='REMOVE'?'移除成员提案':dialog.decision==='APPROVE'?'批准成员变更':'拒绝成员变更'}}</h2><button class="icon-button" title="关闭" aria-label="关闭" :disabled="busy" @click="dialog=undefined"><X :size="17"/></button></div>
      <p v-if="error" class="error-banner" role="alert">{{error}}</p><form class="action-form" @submit.prevent="submit">
        <template v-if="dialog.mode==='CREATE'||dialog.mode==='RENAME'"><label v-if="dialog.mode==='CREATE'">组编码<input v-model="groupId" pattern="[a-z][a-z0-9-]{2,59}" maxlength="60" required/></label><label>组名称<input v-model="groupName" maxlength="80" required/></label></template>
        <template v-else-if="dialog.mode==='ADD'"><div class="group-search"><label>查找工程师<input v-model="query" maxlength="100" @keydown.enter.prevent="search"/></label><button class="icon-button" type="button" title="搜索工程师" aria-label="搜索工程师" :disabled="busy||query.trim().length<2" @click="search"><Search :size="17"/></button></div><label>工程师<select v-model="employeeId" required><option value="" disabled>请选择</option><option v-for="person in people.filter(p=>!detail?.members.some(m=>m.id===p.id))" :key="person.id" :value="person.id">{{person.name}} · {{person.id}}</option></select></label><p v-if="hasMore" class="muted">匹配结果超过 50 人</p></template>
        <p v-else>{{dialog.employeeName??dialog.change?.employeeName}} · {{dialog.change?.operation==='ADD'?'加入支持组':dialog.mode==='REMOVE'||dialog.change?.operation==='REMOVE'?'移除支持组':''}}</p>
        <label>处理依据<textarea v-model="reason" maxlength="1000" rows="3" required/></label><ContentBoundary v-model="safe"/>
        <div class="form-footer"><button class="primary" :disabled="busy||!safe||!reason.trim()||(dialog.mode==='ADD'&&!employeeId)"><LoaderCircle v-if="busy" class="spin" :size="16"/><Check v-else :size="16"/>{{dialog.mode==='ADD'||dialog.mode==='REMOVE'?'提交独立复核':'确认提交'}}</button></div>
      </form>
    </section></div>
    <div v-if="history" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="group-history-title"><div class="section-heading"><h2 id="group-history-title">支持组审计</h2><button class="icon-button" title="关闭" aria-label="关闭" @click="history=undefined"><X :size="17"/></button></div><ol class="group-history"><li v-for="(event,index) in history" :key="index"><strong>{{auditLabels[event.action]??event.action}}</strong><p class="muted">{{event.actorId}} · {{formatDate(event.createdAt)}}</p><p>{{event.reason}}</p></li></ol><p v-if="!history.length" class="muted">暂无审计记录</p></section></div>
  </div>
</template>

<style scoped>
.group-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.group-picker{min-width:0;max-width:100%;flex:1}.group-picker select{max-width:100%;width:340px}.group-heading{margin-top:24px;gap:16px;flex-wrap:wrap}.group-heading>div{min-width:0}.group-heading h2,.group-heading p{overflow-wrap:anywhere}.member-list,.change-list{list-style:none;margin:0;padding:0}.member-list>li,.change-list>li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:20px;align-items:start;padding:18px 0;border-bottom:1px solid #dfe5e8}.member-list p,.change-list p{font-size:12px;margin-top:5px}.member-list strong,.member-list p,.change-list strong,.change-list p{overflow-wrap:anywhere}.group-changes{margin-top:32px}.group-search{display:flex;align-items:end;gap:8px}.group-search label{flex:1;min-width:0}.group-search .icon-button{flex-shrink:0}.group-history{padding-left:20px}.group-history li{padding:12px 0;overflow-wrap:anywhere;border-bottom:1px solid #dfe5e8}.group-history p{font-size:12px;margin-top:6px}@media(max-width:760px){.group-tools.section-heading{align-items:end}.group-picker{flex-basis:100%}.group-picker select{width:100%}.member-list>li,.change-list>li{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}.member-list>li>button,.change-list>li>.group-tools{grid-column:1/-1}.group-heading>.group-tools{width:100%}}
</style>
