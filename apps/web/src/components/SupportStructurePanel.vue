<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import { Check,ChevronLeft,ChevronRight,History,LoaderCircle,Pencil,Plus,Power,RotateCcw,RefreshCw,Search,UserMinus,UserPlus,X } from 'lucide-vue-next';
import type { SessionUser,SupportAuditView,SupportChangeInput,SupportChangeKind,SupportChangeView,SupportDependenciesView,SupportGroupView,SupportMembersView,SupportPeopleView,SupportStructureView } from '@itsm/contracts';
import { api,errorText } from '../api';
import { createRequestKey } from '../request-key';
import { formatDate } from '../labels';
import ContentBoundary from './ContentBoundary.vue';
import SupportDependencyList from './SupportDependencyList.vue';

const props=defineProps<{user:SessionUser}>();
const kinds:Record<SupportChangeKind,string>={GROUP_CREATE:'新增支持组',GROUP_UPDATE:'修改支持组',GROUP_DISABLE:'停用支持组',GROUP_RESTORE:'恢复支持组',MEMBER_ADD:'增加成员',MEMBER_REMOVE:'移除成员'};
const states={PENDING:'待独立复核',APPROVED:'已批准',REJECTED:'已拒绝'};
const roles:Record<string,string>={PLATFORM_ADMIN:'平台管理员',GROUP_LEAD:'支持组长',DISPATCHER:'调度员'};
const privileges:Record<string,string>={P1_REVIEW:'P1 复核',KNOWLEDGE_EDIT:'知识编辑',KNOWLEDGE_REVIEW:'知识审校',CATALOG_PUBLISH:'目录发布'};
const events:Record<string,string>={PROPOSED:'提交提案',APPROVED:'批准',REJECTED:'拒绝'};
const base='/admin/support-structure';
const tab=ref<'groups'|'changes'>('groups'),groups=ref<SupportGroupView[]>([]),items=ref<SupportChangeView[]>([]);
const groupsMore=ref(false),proposalsMore=ref(false),canManageGroups=ref(false),canReview=ref(false);
const selected=ref(''),memberQuery=ref(''),appliedQuery=ref(''),members=ref<SupportMembersView>(),membersLoading=ref(false);
const loading=ref(true),busy=ref(false),error=ref(''),notice=ref('');
const editor=ref<HTMLElement>();
const editing=ref<{kind:SupportChangeKind;groupId:string;expectedGroupVersion:number|null;employeeId?:string;employeeName?:string}>();
const groupCode=ref(''),name=ref(''),description=ref(''),reason=ref(''),safe=ref(false),proposalId=ref(createRequestKey());
const query=ref(''),people=ref<SupportPeopleView>({items:[],hasMore:false}),searched=ref(false),peopleLoading=ref(false),employeeId=ref('');
const decision=ref<{item:SupportChangeView;action:'APPROVE'|'REJECT'}>(),decisionReason=ref(''),decisionSafe=ref(false);
const history=ref<{item:SupportChangeView;events:SupportAuditView[]}>();
const dependencies=ref<SupportDependenciesView>(),dependencyLoading=ref(false);
const selectedGroup=computed(()=>groups.value.find(group=>group.id===selected.value));
const groupEdit=computed(()=>editing.value?.kind==='GROUP_CREATE'||editing.value?.kind==='GROUP_UPDATE');
const lifecycleEdit=computed(()=>editing.value?.kind==='GROUP_DISABLE'||editing.value?.kind==='GROUP_RESTORE');
const pages=computed(()=>Math.max(1,Math.ceil((members.value?.total??0)/(members.value?.size??50))));
const groupName=(id:string)=>groups.value.find(group=>group.id===id)?.name??id;
const canDecide=(item:SupportChangeView)=>canReview.value&&item.status==='PENDING'&&item.proposedBy!==props.user.id&&item.employeeId!==props.user.id;
const changeName=(item:SupportChangeView)=>'name' in item.config?item.config.name:groupName(item.groupId);
let alive=true,memberGeneration=0,peopleGeneration=0,dependencyGeneration=0;

watch([groupCode,name,description,reason,employeeId],()=>{safe.value=false;proposalId.value=createRequestKey();});
watch(decisionReason,()=>{decisionSafe.value=false;});
watch(query,()=>{++peopleGeneration;people.value={items:[],hasMore:false};searched.value=false;employeeId.value='';peopleLoading.value=false;});

async function loadMembers(page=1){
  const group=selected.value;if(!group)return;
  const generation=++memberGeneration;membersLoading.value=true;error.value='';
  try{
    const result=await api<SupportMembersView>(`${base}/groups/${encodeURIComponent(group)}/members?q=${encodeURIComponent(appliedQuery.value)}&page=${page}`);
    if(!alive||generation!==memberGeneration)return;
    members.value=result;groups.value=groups.value.map(row=>row.id===group?result.group:row);
  }catch(e){if(alive&&generation===memberGeneration){members.value=undefined;error.value=errorText(e);}}
  finally{if(alive&&generation===memberGeneration)membersLoading.value=false;}
}
async function load(){
  loading.value=true;error.value='';
  try{
    const result=await api<SupportStructureView>(base);if(!alive)return;
    groups.value=result.groups;items.value=result.items;groupsMore.value=result.groupsHasMore;proposalsMore.value=result.proposalsHasMore;
    canManageGroups.value=result.canManageGroups;canReview.value=result.canReview;
    if(!groups.value.some(group=>group.id===selected.value)){selected.value=groups.value[0]?.id??'';memberQuery.value='';appliedQuery.value='';}
    members.value=undefined;if(selected.value)await loadMembers();
  }catch(e){if(alive)error.value=errorText(e);}finally{if(alive)loading.value=false;}
}
async function selectGroup(){
  members.value=undefined;memberQuery.value='';appliedQuery.value='';notice.value='';await loadMembers();
}
async function searchMembers(){appliedQuery.value=memberQuery.value.trim();await loadMembers();}
async function open(kind:SupportChangeKind,employee?:{id:string;name:string}){
  const group=selectedGroup.value;if(kind!=='GROUP_CREATE'&&!group)return;
  editing.value={kind,groupId:kind==='GROUP_CREATE'?'':group!.id,expectedGroupVersion:kind==='GROUP_CREATE'?null:group!.version,
    ...(employee?{employeeId:employee.id,employeeName:employee.name}:{})};
  groupCode.value=kind==='GROUP_CREATE'?'':group!.id;name.value=kind==='GROUP_UPDATE'?group!.name:'';
  description.value=kind==='GROUP_UPDATE'?group!.description:'';reason.value='';safe.value=false;proposalId.value=createRequestKey();
  query.value='';employeeId.value='';people.value={items:[],hasMore:false};searched.value=false;error.value='';notice.value='';
  dependencies.value=undefined;++dependencyGeneration;dependencyLoading.value=false;
  if(kind==='GROUP_DISABLE')void loadDependencies(group!.id);
  await nextTick();
  if(!alive||!editing.value)return;
  editor.value?.scrollIntoView({block:'start'});
  editor.value?.querySelector<HTMLInputElement|HTMLTextAreaElement>('input,textarea')?.focus({preventScroll:true});
}
function closeEditor(){editing.value=undefined;++peopleGeneration;peopleLoading.value=false;++dependencyGeneration;dependencyLoading.value=false;}
async function loadDependencies(group:string){
  const generation=++dependencyGeneration;dependencies.value=undefined;dependencyLoading.value=true;error.value='';
  try{
    const result=await api<SupportDependenciesView>(`${base}/groups/${encodeURIComponent(group)}/dependencies`);
    if(alive&&generation===dependencyGeneration)dependencies.value=result;
  }catch(e){if(alive&&generation===dependencyGeneration)error.value=errorText(e);}
  finally{if(alive&&generation===dependencyGeneration)dependencyLoading.value=false;}
}
async function searchPeople(){
  if(query.value.trim().length<2||peopleLoading.value)return;
  const generation=++peopleGeneration;peopleLoading.value=true;error.value='';employeeId.value='';
  try{
    const result=await api<SupportPeopleView>(`${base}/people?q=${encodeURIComponent(query.value.trim())}`);
    if(alive&&generation===peopleGeneration){people.value=result;searched.value=true;}
  }catch(e){if(alive&&generation===peopleGeneration)error.value=errorText(e);}
  finally{if(alive&&generation===peopleGeneration)peopleLoading.value=false;}
}
async function propose(){
  const current=editing.value;if(!current||busy.value||!safe.value||!reason.value.trim())return;
  const target=current.kind==='MEMBER_ADD'?employeeId.value:current.employeeId;
  if(!groupEdit.value&&!lifecycleEdit.value&&!target)return;
  if(current.kind==='GROUP_DISABLE'&&(!dependencies.value||dependencies.value.total||dependencyLoading.value))return;
  const input:SupportChangeInput={id:proposalId.value,kind:current.kind,groupId:current.kind==='GROUP_CREATE'?groupCode.value:current.groupId,
    expectedGroupVersion:current.expectedGroupVersion,config:groupEdit.value?{name:name.value,description:description.value}:{},
    ...(target?{employeeId:target}:{}),reason:reason.value,contentClass:'GENERAL'};
  busy.value=true;error.value='';notice.value='';
  try{
    await api<SupportChangeView>(canManageGroups.value?`${base}/apply`:base,{method:'POST',body:input});if(!alive)return;
    closeEditor();tab.value=canManageGroups.value?'groups':'changes';await load();notice.value=canManageGroups.value?'配置已保存并生效。':'变更已提交，待其他平台管理员独立复核，当前配置尚未改变。';
  }catch(e){if(alive)error.value=errorText(e);}finally{if(alive)busy.value=false;}
}
function review(item:SupportChangeView,action:'APPROVE'|'REJECT'){
  decision.value={item,action};decisionReason.value='';decisionSafe.value=false;error.value='';notice.value='';
  dependencies.value=undefined;++dependencyGeneration;dependencyLoading.value=false;
  if(item.kind==='GROUP_DISABLE'&&action==='APPROVE')void loadDependencies(item.groupId);
}
async function decide(){
  const current=decision.value;if(!current||busy.value||!decisionSafe.value||!decisionReason.value.trim())return;
  if(current.action==='APPROVE'&&current.item.kind==='GROUP_DISABLE'&&(!dependencies.value||dependencies.value.total||dependencyLoading.value))return;
  busy.value=true;error.value='';
  try{
    await api(`${base}/${current.item.id}/review`,{method:'POST',body:{expectedVersion:current.item.version,decision:current.action,
      reason:decisionReason.value,contentClass:'GENERAL'}});if(!alive)return;
    decision.value=undefined;await load();notice.value=current.action==='APPROVE'?'变更已批准并生效。':'提案已拒绝，当前配置未改变。';
  }catch(e){if(alive)error.value=errorText(e);}finally{if(alive)busy.value=false;}
}
async function showHistory(item:SupportChangeView){
  if(busy.value)return;busy.value=true;error.value='';
  try{const result=await api<{items:SupportAuditView[]}>(`${base}/${item.id}/history`);if(alive)history.value={item,events:result.items};}
  catch(e){if(alive)error.value=errorText(e);}finally{if(alive)busy.value=false;}
}
onMounted(load);
onBeforeUnmount(()=>{alive=false;++memberGeneration;++peopleGeneration;++dependencyGeneration;});
</script>

<template>
  <div class="support-panel">
    <p v-if="error&&!decision&&!editing" class="error-banner" role="alert">{{error}}</p>
    <p v-if="notice" class="support-notice" role="status">{{notice}}</p>
    <div class="section-heading"><div class="support-tabs" role="tablist" aria-label="支持组管理视图">
      <button role="tab" :aria-selected="tab==='groups'" :disabled="!!editing||busy" @click="tab='groups'">支持组与成员</button>
      <button role="tab" :aria-selected="tab==='changes'" :disabled="!!editing||busy" @click="tab='changes'">成员及组变更</button>
    </div><div class="support-tools">
      <button class="icon-button" title="刷新支持组" aria-label="刷新支持组" :disabled="busy||loading||!!editing||!!decision" @click="load"><RefreshCw :size="17" :class="{spin:loading}"/></button>
      <button v-if="canManageGroups&&tab==='groups'" class="primary" :disabled="busy||loading||!!editing" @click="open('GROUP_CREATE')"><Plus :size="17"/>新增支持组</button>
    </div></div>
    <p v-if="groupsMore" class="danger-text">支持组仅显示前 200 条，清单尚未完整。</p>

    <section v-if="editing" ref="editor" class="detail-section support-editor" :aria-label="kinds[editing.kind]">
      <div class="section-heading"><h2>{{kinds[editing.kind]}}</h2><button class="icon-button" title="取消编辑" aria-label="取消编辑" :disabled="busy" @click="closeEditor"><X :size="17"/></button></div>
      <p v-if="error" class="error-banner" role="alert">{{error}}</p>
      <form class="action-form" @submit.prevent="propose"><fieldset :disabled="busy" class="support-fields">
        <div v-if="groupEdit" class="form-grid">
          <label>支持组编码<input v-model="groupCode" required pattern="[a-zA-Z0-9_-]+" maxlength="100" :readonly="editing.kind==='GROUP_UPDATE'"/></label>
          <label>支持组名称<input v-model="name" required maxlength="100"/></label>
          <label class="full">职责说明<textarea v-model="description" maxlength="1000" rows="3"/></label>
        </div>
        <template v-else>
          <p>{{groupName(editing.groupId)}}<span v-if="editing.employeeName"> · {{editing.employeeName}}</span></p>
          <template v-if="editing.kind==='MEMBER_ADD'">
            <div class="support-search"><label>员工搜索<input v-model="query" maxlength="100" autocomplete="off" @keydown.enter.prevent="searchPeople"/></label><button type="button" class="icon-button" title="搜索员工" aria-label="搜索员工" :disabled="peopleLoading||query.trim().length<2" @click="searchPeople"><Search :size="17"/></button></div>
            <label>任职员工<select v-model="employeeId" required :disabled="peopleLoading||!people.items.length"><option value="">请选择员工</option><option v-for="person in people.items" :key="person.id" :value="person.id">{{person.name}} · {{person.id}}</option></select></label>
            <p v-if="searched&&!people.items.length" class="muted">未找到匹配的有效员工</p><p v-if="people.hasMore" class="danger-text">员工结果未完整，请缩小搜索范围。</p>
          </template>
        </template>
        <SupportDependencyList v-if="editing.kind==='GROUP_DISABLE'" :value="dependencies" :busy="dependencyLoading||busy" @refresh="loadDependencies(editing.groupId)"/>
        <p v-if="editing.kind==='GROUP_RESTORE'" class="muted">恢复后成员、岗位任职及权限仍需重新任命。</p>
        <label>变更依据<textarea v-model="reason" required maxlength="500" rows="3"/></label>
        <ContentBoundary v-model="safe"/>
        <div class="form-footer"><button class="primary" :disabled="!safe||!reason.trim()||(groupEdit?!name.trim():editing.kind==='MEMBER_ADD'&&!employeeId)||(editing.kind==='GROUP_DISABLE'&&(!dependencies||dependencies.total>0||dependencyLoading))"><LoaderCircle v-if="busy" class="spin" :size="16"/><Check v-else :size="16"/>{{canManageGroups?'保存并生效':'提交独立复核'}}</button></div>
      </fieldset></form>
    </section>

    <div v-if="loading" class="empty-state"><LoaderCircle class="spin" :size="26"/></div>
    <template v-else-if="tab==='groups'">
      <div class="support-group-heading"><label>当前支持组<select v-model="selected" :disabled="busy||!!editing||membersLoading" @change="selectGroup"><option v-if="!groups.length" value="">暂无支持组</option><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}} · {{group.enabled?`${group.activeMembers} 名有效成员`:'已停用'}}</option></select></label><div v-if="selectedGroup" class="support-tools">
        <button v-if="canManageGroups" class="icon-button" title="修改支持组" aria-label="修改支持组" :disabled="busy||!!editing||membersLoading" @click="open('GROUP_UPDATE')"><Pencil :size="17"/></button>
        <button v-if="canManageGroups" class="icon-button" :title="selectedGroup.enabled?'停用支持组':'恢复支持组'" :aria-label="selectedGroup.enabled?'停用支持组':'恢复支持组'" :disabled="busy||!!editing||membersLoading" @click="open(selectedGroup.enabled?'GROUP_DISABLE':'GROUP_RESTORE')"><Power v-if="selectedGroup.enabled" :size="17"/><RotateCcw v-else :size="17"/></button>
        <button class="secondary" :disabled="busy||!!editing||membersLoading||!selectedGroup.enabled" @click="open('MEMBER_ADD')"><UserPlus :size="17"/>增加成员</button>
      </div></div>
      <section v-if="selectedGroup" class="detail-section" aria-label="组内成员">
        <div class="section-heading"><div><h2>{{selectedGroup.name}}</h2><p class="muted multiline">{{selectedGroup.description}}</p><p class="mono muted">{{selectedGroup.id}} · 版本 {{selectedGroup.version}}</p></div></div>
        <form class="support-search" @submit.prevent="searchMembers"><label>成员搜索<input v-model="memberQuery" :disabled="busy||!!editing" maxlength="100"/></label><button class="icon-button" title="搜索成员" aria-label="搜索成员" :disabled="busy||!!editing||membersLoading"><Search :size="17"/></button></form>
        <div v-if="membersLoading" class="empty-state"><LoaderCircle class="spin" :size="24"/></div>
        <ul v-else class="support-member-list"><li v-for="member in members?.items??[]" :key="member.id" :aria-label="member.name">
          <div><strong>{{member.name}}</strong><p class="mono muted">{{member.id}}</p><span :class="member.active?'muted':'danger-text'">{{member.active?'在职':'已停用'}}</span></div>
          <div><p>{{member.active?member.roles.map(role=>roles[role]??role).join('、')||'组内工程师':'无有效操作权限'}}</p><p class="muted">{{member.privileges.map(value=>privileges[value]??value).join('、')||'无附加授权'}}</p></div>
          <button class="icon-button" :title="`移除${member.name}`" :aria-label="`移除${member.name}`" :disabled="busy||!!editing" @click="open('MEMBER_REMOVE',member)"><UserMinus :size="17"/></button>
        </li></ul>
        <p v-if="!membersLoading&&members&&!members.items.length" class="support-empty muted">{{appliedQuery?'没有匹配的组内成员':'此组暂无成员'}}</p>
        <footer v-if="members" class="pagination"><span>共 {{members.total}} 人</span><div><button class="icon-button" title="上一页成员" aria-label="上一页成员" :disabled="busy||membersLoading||!!editing||members.page<=1" @click="loadMembers(members.page-1)"><ChevronLeft :size="17"/></button><span>{{members.page}} / {{pages}}</span><button class="icon-button" title="下一页成员" aria-label="下一页成员" :disabled="busy||membersLoading||!!editing||members.page>=pages" @click="loadMembers(members.page+1)"><ChevronRight :size="17"/></button></div></footer>
      </section>
    </template>
    <section v-else class="detail-section" aria-label="支持组变更记录">
      <div class="section-heading"><h2>变更记录</h2><span class="muted">最近 200 条</span></div><p v-if="proposalsMore" class="danger-text">变更记录未完整，当前仅显示最近 200 条。</p>
      <ul class="support-change-list"><li v-for="item in items" :key="item.id" :aria-label="`${kinds[item.kind]} ${item.reason}`">
        <div><strong>{{kinds[item.kind]}}</strong><p>{{changeName(item)}}<span v-if="item.employeeId"> · {{item.employeeName??item.employeeId}}</span></p><p class="mono muted">{{item.groupId}}</p></div>
        <div><span class="status">{{states[item.status]}}</span><p>{{item.reason}}</p><p v-if="'description' in item.config" class="muted multiline">{{item.config.description}}</p><p v-if="item.reviewReason" class="muted">{{item.reviewReason}}</p></div>
        <div class="support-change-meta"><time>{{formatDate(item.createdAt)}}</time><p class="mono muted">提交：{{item.proposedBy}}</p><p v-if="item.reviewedBy" class="mono muted">复核：{{item.reviewedBy}}</p></div>
        <div class="support-tools"><template v-if="canDecide(item)">
          <button class="icon-button" title="批准变更" aria-label="批准变更" :disabled="busy" @click="review(item,'APPROVE')"><Check :size="17"/></button>
          <button class="icon-button" title="拒绝变更" aria-label="拒绝变更" :disabled="busy" @click="review(item,'REJECT')"><X :size="17"/></button>
        </template><button class="icon-button" title="变更审计" aria-label="变更审计" :disabled="busy" @click="showHistory(item)"><History :size="17"/></button></div>
      </li></ul><p v-if="!items.length" class="support-empty muted">暂无支持组变更记录</p>
    </section>

    <div v-if="decision" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="support-review-title">
      <div class="section-heading"><h2 id="support-review-title">{{decision.action==='APPROVE'?'批准变更':'拒绝变更'}}</h2><button class="icon-button" title="关闭复核" aria-label="关闭复核" :disabled="busy" @click="decision=undefined"><X :size="17"/></button></div>
      <p v-if="error" class="error-banner" role="alert">{{error}}</p>
      <p>{{kinds[decision.item.kind]}} · {{changeName(decision.item)}}<span v-if="decision.item.employeeId"> · {{decision.item.employeeName??decision.item.employeeId}}</span></p>
      <p class="muted multiline">{{decision.item.reason}}</p>
      <SupportDependencyList v-if="decision.item.kind==='GROUP_DISABLE'&&decision.action==='APPROVE'" :value="dependencies" :busy="dependencyLoading||busy" @refresh="loadDependencies(decision.item.groupId)"/>
      <p v-if="decision.item.kind==='GROUP_RESTORE'&&decision.action==='APPROVE'" class="muted">恢复后成员、岗位任职及权限仍需重新任命。</p>
      <form class="action-form" @submit.prevent="decide"><fieldset class="support-fields" :disabled="busy"><label>复核依据<textarea v-model="decisionReason" required maxlength="500" rows="3"/></label><ContentBoundary v-model="decisionSafe"/><div class="form-footer"><button class="primary" :disabled="!decisionSafe||!decisionReason.trim()||(decision.item.kind==='GROUP_DISABLE'&&decision.action==='APPROVE'&&(!dependencies||dependencies.total>0||dependencyLoading))"><LoaderCircle v-if="busy" class="spin" :size="16"/><Check v-else :size="16"/>确认复核</button></div></fieldset></form>
    </section></div>
    <div v-if="history" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="support-history-title">
      <div class="section-heading"><h2 id="support-history-title">支持组变更审计</h2><button class="icon-button" title="关闭审计" aria-label="关闭审计" @click="history=undefined"><X :size="17"/></button></div>
      <p>{{kinds[history.item.kind]}} · {{changeName(history.item)}}</p>
      <ol class="support-audit"><li v-for="(event,index) in history.events" :key="index"><strong>{{events[event.action]??event.action}}</strong><p class="mono muted">{{event.actorId}} · {{formatDate(event.createdAt)}}</p><p>{{event.reason}}</p><details><summary>变更快照</summary><pre>{{JSON.stringify({before:event.beforeValue,after:event.afterValue},null,2)}}</pre></details></li></ol>
    </section></div>
  </div>
</template>

<style scoped>
.support-panel{min-width:0}.support-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.support-tabs{display:flex;gap:16px;min-width:0;flex-wrap:wrap}.support-tabs button{padding:10px 0;border-radius:0;border-bottom:2px solid transparent;color:#607079}.support-tabs button[aria-selected=true]{border-bottom-color:#117965;color:#10735f}.support-group-heading{display:flex;align-items:end;gap:16px;flex-wrap:wrap;margin:22px 0}.support-group-heading>label{flex:1;min-width:180px}.support-panel>.detail-section{margin-top:24px}.support-fields{border:0;padding:0;margin:0;min-width:0;display:grid;gap:18px}.support-fields .full{grid-column:1/-1}.support-search{display:flex;align-items:end;gap:8px;margin:14px 0}.support-search>label{flex:1;min-width:0}.support-search>.icon-button{flex:none;margin-bottom:3px}.support-member-list,.support-change-list{padding:0;margin:16px 0 0;list-style:none}.support-member-list>li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) 36px;gap:16px;padding:18px 0;border-bottom:1px solid #dfe5e8}.support-member-list p,.support-change-list p{margin-top:6px;font-size:12px;overflow-wrap:anywhere}.support-member-list span{display:block;font-size:12px;margin-top:6px}.support-member-list strong{font-size:14px;overflow-wrap:anywhere}.support-change-list>li{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr) auto;gap:16px;padding:20px 0;border-bottom:1px solid #dfe5e8}.support-change-list>li>div{min-width:0}.support-change-list strong{font-size:14px}.support-change-meta time{font-size:12px}.support-change-list .support-tools{align-self:start}.support-notice{padding:12px 16px;border-left:3px solid #117965;background:#edf8f4;color:#245c47;font-size:13px;margin-bottom:16px}.support-empty{padding:22px 0;font-size:13px}.support-audit{padding-left:20px}.support-audit li{padding:14px 0;border-bottom:1px solid #dfe5e8;overflow-wrap:anywhere}.support-audit p,.support-audit summary{font-size:12px;margin-top:8px}.support-audit pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font-size:11px}.support-panel .modal>p{overflow-wrap:anywhere;font-size:13px;line-height:1.7}@media(max-width:1100px){.support-change-list>li{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.support-panel>.section-heading{align-items:start;gap:12px;flex-wrap:wrap}.support-tabs{gap:12px}.support-tabs button{font-size:12px}.support-panel .form-grid{grid-template-columns:minmax(0,1fr)}.support-member-list>li{gap:10px;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 36px}.support-member-list strong{font-size:13px}.support-change-list>li{gap:12px}.support-change-list .support-tools{grid-column:1/-1}.support-panel .modal{max-width:calc(100vw - 32px)}}
</style>
