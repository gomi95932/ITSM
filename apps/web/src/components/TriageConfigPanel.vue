<script setup lang="ts">
import {computed,onMounted,ref,watch} from 'vue';
import {Check,RefreshCw,Search,ArrowRight} from 'lucide-vue-next';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import {formatDate} from '../labels';
import ContentBoundary from './ContentBoundary.vue';
import OperationLogLink from './OperationLogLink.vue';

type Policy={version:number;enabled:boolean;primary_employee_id:string|null;backup_employee_id:string|null;
  primary_name:string|null;backup_name:string|null;primary_active:boolean|null;backup_active:boolean|null;reminder_minutes:number};
type Backlog={ticket_id:string;number:string;subject:string;ticket_version:number;coordinator_name:string|null;
  stage:string;due_at:string|null;policy_version:number};
const policy=ref<Policy|null>(null),backlog=ref<Backlog[]>([]),counts=ref({pending:0,escalated:0});
const enabled=ref(false),primary=ref(''),backup=ref(''),minutes=ref(60),reason=ref(''),safe=ref(false);
const busy=ref(false),loading=ref(false),error=ref(''),notice=ref(''),requestId=ref(createRequestKey());
const query=ref(''),people=ref<{id:string;name:string}[]>([]),searching=ref(false),more=ref(false);
const transfer=ref<Backlog>(),transferReason=ref(''),transferSafe=ref(false),transferId=ref(createRequestKey());
const choices=computed(()=>{
  const found=new Map(people.value.map(p=>[p.id,p]));
  if(policy.value?.primary_employee_id)found.set(policy.value.primary_employee_id,{id:policy.value.primary_employee_id,name:policy.value.primary_name??policy.value.primary_employee_id});
  if(policy.value?.backup_employee_id)found.set(policy.value.backup_employee_id,{id:policy.value.backup_employee_id,name:policy.value.backup_name??policy.value.backup_employee_id});
  return [...found.values()];
});
watch([enabled,primary,backup,minutes,reason],()=>{safe.value=false;requestId.value=createRequestKey();});
watch(transferReason,()=>{transferSafe.value=false;transferId.value=createRequestKey();});
async function load(){
  loading.value=true;error.value='';
  try{
    const result=await api<{policy:Policy|null;backlog:Backlog[];counts:{pending:number;escalated:number}}>('/admin/routing-config/triage');
    policy.value=result.policy;backlog.value=result.backlog;counts.value=result.counts;
    enabled.value=result.policy?.enabled??false;primary.value=result.policy?.primary_employee_id??'';
    backup.value=result.policy?.backup_employee_id??'';minutes.value=result.policy?.reminder_minutes??60;
  }catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
async function search(){
  if(query.value.trim().length<2||searching.value)return;
  searching.value=true;error.value='';
  try{const result=await api<{items:{id:string;name:string}[];hasMore:boolean}>(`/admin/support-structure/people?q=${encodeURIComponent(query.value.trim())}`);
    const retained=people.value.filter(p=>p.id===primary.value||p.id===backup.value);
    people.value=[...new Map([...retained,...result.items].map(p=>[p.id,p])).values()];more.value=result.hasMore;
  }catch(e){error.value=errorText(e);}finally{searching.value=false;}
}
async function save(){
  if(busy.value||!safe.value)return;
  busy.value=true;error.value='';notice.value='';
  try{await api('/admin/routing-config/triage',{method:'POST',body:{id:requestId.value,expectedVersion:policy.value?.version??0,
    enabled:enabled.value,primaryEmployeeId:primary.value||null,backupEmployeeId:backup.value||null,
    reminderMinutes:minutes.value,reason:reason.value,contentClass:'GENERAL'}});
    await load();reason.value='';safe.value=false;notice.value='配置已生效';
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function transferTicket(){
  if(!transfer.value||busy.value||!transferSafe.value)return;
  busy.value=true;error.value='';
  try{await api('/admin/routing-config/triage/transfer',{method:'POST',body:{id:transferId.value,ticketId:transfer.value.ticket_id,
    expectedVersion:transfer.value.ticket_version,expectedPolicyVersion:policy.value?.version,reason:transferReason.value,contentClass:'GENERAL'}});
    transfer.value=undefined;await load();notice.value='待分派责任已按当前配置转交';
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
onMounted(load);
</script>

<template>
  <section class="detail-section triage-config">
    <div class="section-heading"><h2>统一兜底分派</h2><div class="tools"><OperationLogLink module="routing"/>
      <button class="icon-button" title="刷新兜底配置" aria-label="刷新兜底配置" :disabled="busy||loading" @click="load"><RefreshCw :size="17" :class="{spin:loading}"/></button></div></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p><p v-if="notice" role="status">{{notice}}</p>
    <p v-if="!policy?.enabled" class="muted">统一兜底未启用</p>
    <p v-else-if="!policy.primary_active||!policy.backup_active" class="amber-text" role="alert">{{!policy.primary_active?'主负责人已失效。':''}}{{!policy.backup_employee_id?'尚未设置备用负责人。':!policy.backup_active?'备用负责人已失效。':''}}</p>
    <form class="action-form" @submit.prevent="save">
      <label class="check-label"><input v-model="enabled" type="checkbox"/>启用统一兜底</label>
      <div class="people-search"><label>查找钉钉人员<input v-model="query" placeholder="姓名至少两个字" @keydown.enter.prevent="search"/></label>
        <button class="icon-button" type="button" title="查找人员" aria-label="查找人员" :disabled="searching||query.trim().length<2" @click="search"><Search :size="18"/></button></div>
      <p v-if="more" class="muted">匹配人数较多，请输入更完整的姓名</p>
      <div class="triage-fields"><label>主负责人<select v-model="primary" :required="enabled"><option value="">未选择</option><option v-for="p in choices" :key="p.id" :value="p.id">{{p.name}}</option></select></label>
        <label>备用负责人<select v-model="backup"><option value="">未设置</option><option v-for="p in choices.filter(p=>p.id!==primary)" :key="p.id" :value="p.id">{{p.name}}</option></select></label>
        <label>分派超时（自然分钟）<input v-model.number="minutes" type="number" min="1" max="10080" required/></label></div>
      <label>变更依据<textarea v-model="reason" required maxlength="500" rows="2"/></label><ContentBoundary v-model="safe"/>
      <div class="form-footer"><button class="primary" :disabled="busy||loading||!safe||!reason.trim()||enabled&&!primary||!!backup&&backup===primary"><Check :size="16"/>保存并生效</button></div>
    </form>
    <div class="section-heading"><h3>待分派积压 {{counts.pending}}</h3><span :class="counts.escalated?'amber-text':'muted'">管理员待接管 {{counts.escalated}}</span></div>
    <div class="table-wrap"><table><thead><tr><th>工单</th><th>待分派负责人</th><th>截止时间</th><th>配置版本</th><th>转交</th></tr></thead>
      <tbody><tr v-for="t in backlog" :key="t.ticket_id"><td><a :href="`#/tickets/${t.ticket_id}`">{{t.number}}</a><small>{{t.subject}}</small></td>
        <td>{{t.stage==='ESCALATED'?'等待管理员接管':t.coordinator_name??'人员已失效'}}<small>{{t.stage==='BACKUP'?'备用负责人':t.stage==='PRIMARY'?'主负责人':''}}</small></td>
        <td>{{t.due_at?formatDate(t.due_at):'—'}}</td><td>v{{t.policy_version}}</td><td><button class="icon-button" title="按当前配置转交" aria-label="按当前配置转交" :disabled="busy||!policy?.enabled" @click="transfer=t;transferReason='';transferSafe=false;transferId=createRequestKey()"><ArrowRight :size="17"/></button></td></tr></tbody></table>
      <p v-if="!backlog.length" class="empty-state">暂无待分派工单</p><p v-if="counts.pending>backlog.length" class="muted">显示前 {{backlog.length}} 条</p></div>
    <div v-if="transfer" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="triage-transfer-title">
      <h2 id="triage-transfer-title">转交 {{transfer.number}}</h2><p>按当前配置 v{{policy?.version}} 重新指定待分派负责人。</p>
      <form class="action-form" @submit.prevent="transferTicket"><label>转交原因<textarea v-model="transferReason" maxlength="500" required/></label><ContentBoundary v-model="transferSafe"/>
        <div class="form-footer"><button type="button" :disabled="busy" @click="transfer=undefined">取消</button><button class="primary" :disabled="busy||!transferSafe||!transferReason.trim()"><Check :size="16"/>确认转交</button></div></form></section></div>
  </section>
</template>

<style scoped>
.tools,.people-search{display:flex;align-items:center;gap:8px}.people-search label{flex:1}.people-search button{align-self:flex-end}.triage-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.check-label{display:flex;align-items:center;gap:8px}.check-label input{width:auto}small{display:block;overflow-wrap:anywhere}.triage-config table{min-width:620px}.triage-config h3{font-size:15px}@media(max-width:760px){.triage-fields{grid-template-columns:1fr}}
</style>
