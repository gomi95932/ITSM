<script setup lang="ts">
import {onMounted,ref,watch} from 'vue';
import {Check,RefreshCw,Send,X} from 'lucide-vue-next';
import {DEFAULT_PRIORITY_POLICY,PRIORITIES,PRIORITY_LABELS,type PriorityPolicy,type SessionUser,type CatalogItem} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import ContentBoundary from './ContentBoundary.vue';
type Proposal={id:string;config:PriorityPolicy;reason:string;proposed_by:string;status:string;review_reason:string|null;version:number;expected_version:number};
const props=defineProps<{user:SessionUser}>();
const config=ref<PriorityPolicy>(structuredClone(DEFAULT_PRIORITY_POLICY)),version=ref(1),approved=ref(false),proposals=ref<Proposal[]>([]),services=ref<CatalogItem[]>([]);
const busy=ref(false),error=ref(''),reason=ref(''),safe=ref(false),reviewReason=ref(''),reviewSafe=ref(false),id=ref(createRequestKey());
const impacts=[{code:'COMPANY' as const,name:'全公司 / 核心生产'},{code:'DEPARTMENT' as const,name:'部门 / 多人'},{code:'INDIVIDUAL' as const,name:'单人'}];
const urgencies=[{code:'HIGH' as const,name:'工作中断'},{code:'MEDIUM' as const,name:'明显影响'},{code:'LOW' as const,name:'轻微 / 可计划'}];
watch([config,reason],()=>{safe.value=false;id.value=createRequestKey();},{deep:true});
watch(reviewReason,()=>{reviewSafe.value=false;});
async function load(){busy.value=true;error.value='';try{
  const result=await api<{current:{config:PriorityPolicy;version:number;approved:boolean};proposals:Proposal[]}>('/admin/priority-policy');
  config.value=structuredClone(result.current.config);version.value=result.current.version;approved.value=result.current.approved;proposals.value=result.proposals;
  services.value=(await api<{items:CatalogItem[]}>('/catalog')).items;
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function propose(){if(!safe.value||busy.value)return;busy.value=true;error.value='';try{
  await api('/admin/priority-policy',{method:'POST',body:{id:id.value,expectedVersion:version.value,config:config.value,reason:reason.value,contentClass:'GENERAL'}});
  reason.value='';await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function review(p:Proposal,decision:'APPROVE'|'REJECT'){if(!reviewSafe.value||!reviewReason.value.trim()||busy.value)return;busy.value=true;error.value='';try{
  await api(`/admin/priority-policy/${p.id}/review`,{method:'POST',body:{expectedVersion:p.version,decision,reason:reviewReason.value,contentClass:'GENERAL'}});
  reviewReason.value='';await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
onMounted(load);
</script>
<template>
  <section aria-label="分级与时限配置">
    <div class="section-heading"><h2>分级与时限 · V{{version}}</h2><button class="icon-button" aria-label="刷新分级配置" title="刷新" :disabled="busy" @click="load"><RefreshCw :size="18"/></button></div>
    <p class="muted">{{approved?'已批准':'试行，待业务与值班能力确认'}} · P1 连续计时，P2–P4 按服务日历计时</p>
    <p v-if="error" role="alert" class="error-banner">{{error}}</p>
    <form @submit.prevent="propose" class="action-form">
      <div class="table-wrap"><table class="priority-matrix"><thead><tr><th>影响范围</th><th v-for="u in urgencies" :key="u.code">{{u.name}}</th></tr></thead><tbody><tr v-for="i in impacts" :key="i.code"><th>{{i.name}}</th><td v-for="u in urgencies" :key="u.code"><select v-model="config.matrix[i.code][u.code]" :aria-label="`${i.name} ${u.name}`"><option v-for="p in PRIORITIES" :key="p" :value="p">{{p}}</option></select></td></tr></tbody></table></div>
      <div class="table-wrap"><table><thead><tr><th>优先级</th><th>首次响应（分钟）</th><th>解决 / 交付（分钟）</th></tr></thead><tbody><tr v-for="p in PRIORITIES" :key="p"><th>{{p}} · {{PRIORITY_LABELS[p]}}</th><td><input v-model.number="config.targets[p].response" type="number" min="1" max="43200" required :aria-label="`${p} 响应分钟`"/></td><td><input v-model.number="config.targets[p].resolution" type="number" min="1" max="43200" required :aria-label="`${p} 解决分钟`"/></td></tr></tbody></table></div>
      <label>P1 主管确认提醒（分钟）<input v-model.number="config.reviewMinutes" type="number" min="1" max="60" required/></label>
      <fieldset><legend>关键服务（中断且无替代方式时进入 P1 候选）</legend><label v-for="s in services" :key="s.code" class="checkbox-label"><input v-model="config.criticalServices" type="checkbox" :value="s.code"/>{{s.name}}</label></fieldset>
      <label>变更原因<textarea v-model="reason" maxlength="500" required rows="2"/></label><ContentBoundary v-model="safe"/>
      <button class="primary" :disabled="busy||!safe||!reason.trim()"><Send :size="16"/>提交配置审批</button>
    </form>
    <section class="detail-section"><h2>配置审批记录</h2><label>复核意见<textarea v-model="reviewReason" maxlength="500" rows="2"/></label><ContentBoundary v-model="reviewSafe"/>
      <div v-for="p in proposals" :key="p.id" class="detail-section"><strong>{{p.status==='PENDING'?'待复核':p.status==='APPROVED'?'已批准':'已拒绝'}} · 基于 V{{p.expected_version}}</strong><p>{{p.reason}}</p><details><summary>查看提交配置</summary><div class="table-wrap"><table><thead><tr><th>影响范围</th><th v-for="u in urgencies" :key="u.code">{{u.name}}</th></tr></thead><tbody><tr v-for="i in impacts" :key="i.code"><th>{{i.name}}</th><td v-for="u in urgencies" :key="u.code">{{p.config.matrix[i.code][u.code]}}</td></tr></tbody></table><table><tbody><tr v-for="v in PRIORITIES" :key="v"><th>{{v}}</th><td>响应 {{p.config.targets[v].response}} 分 / 解决 {{p.config.targets[v].resolution}} 分</td></tr></tbody></table><p>关键服务：{{p.config.criticalServices.join('、')||'无'}} · 提醒 {{p.config.reviewMinutes}} 分钟</p></div></details><p v-if="p.review_reason">{{p.review_reason}}</p>
        <div v-if="p.status==='PENDING'&&p.proposed_by!==user.id" class="form-footer"><button class="secondary" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review(p,'REJECT')"><X :size="16"/>拒绝</button><button class="primary" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review(p,'APPROVE')"><Check :size="16"/>批准</button></div>
      </div><p v-if="!proposals.length" class="muted">暂无配置变更</p>
    </section>
  </section>
</template>
<style scoped>
@media(max-width:760px){
  .priority-matrix{table-layout:fixed;width:100%}
  .priority-matrix th,.priority-matrix td{padding:10px 4px;white-space:normal;overflow-wrap:anywhere}
  .priority-matrix th:first-child{width:30%}
  .priority-matrix select{min-width:0;padding:8px 4px;font-size:13px}
}
</style>
