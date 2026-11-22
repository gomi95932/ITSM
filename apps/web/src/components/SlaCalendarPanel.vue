<script setup lang="ts">
import {onMounted,ref,watch} from 'vue';
import {Check,Plus,RefreshCw,Send,Trash2,X} from 'lucide-vue-next';
import {DEFAULT_CALENDAR,type ServiceCalendar,type SessionUser} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import ContentBoundary from './ContentBoundary.vue';
type Version={version:number;config:ServiceCalendar;approved:boolean;created_at:string;created_by:string|null};
type Proposal={id:string;expected_version:number;config:ServiceCalendar;proposed_by:string;reason:string;status:string;version:number;review_reason:string|null};
defineProps<{user:SessionUser}>();
const config=ref<ServiceCalendar>(structuredClone(DEFAULT_CALENDAR)),version=ref(1),approved=ref(false),proposals=ref<Proposal[]>([]),history=ref<Version[]>([]);
const busy=ref(false),error=ref(''),reason=ref(''),safe=ref(false),reviewReason=ref(''),reviewSafe=ref(false),id=ref(createRequestKey());
const holiday=ref(''),workday=ref('');
watch([config,reason],()=>{safe.value=false;id.value=createRequestKey();},{deep:true});
watch(reviewReason,()=>{reviewSafe.value=false;});
async function load(){busy.value=true;error.value='';try{
  const result=await api<{current:Version;proposals:Proposal[];history:Version[]}>('/admin/sla-calendar');
  config.value=structuredClone(result.current.config);version.value=result.current.version;approved.value=result.current.approved;proposals.value=result.proposals;history.value=result.history;
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
function addDate(kind:'holidays'|'workdays'){
  const date=kind==='holidays'?holiday.value:workday.value;
  if(!date||config.value[kind].includes(date))return;
  config.value[kind]=[...config.value[kind],date].sort();
  if(kind==='holidays')holiday.value='';else workday.value='';
}
async function propose(){if(busy.value||!safe.value)return;busy.value=true;error.value='';try{
  await api('/admin/sla-calendar',{method:'POST',body:{id:id.value,expectedVersion:version.value,config:config.value,reason:reason.value,contentClass:'GENERAL'}});
  reason.value='';await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function review(p:Proposal,decision:'APPROVE'|'REJECT'){if(busy.value||!reviewSafe.value||!reviewReason.value.trim())return;busy.value=true;error.value='';try{
  await api(`/admin/sla-calendar/${p.id}/review`,{method:'POST',body:{expectedVersion:p.version,decision,reason:reviewReason.value,contentClass:'GENERAL'}});
  reviewReason.value='';await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
onMounted(load);
</script>
<template>
  <section aria-label="服务日历配置" class="detail-section">
    <div class="section-heading"><h2>服务日历 · V{{version}}</h2><button class="icon-button" title="刷新服务日历" aria-label="刷新服务日历" :disabled="busy" @click="load"><RefreshCw :size="18"/></button></div>
    <p class="muted">{{approved?'已批准':'试行，待复核'}} · Asia/Shanghai · 周一至周五</p>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <form class="action-form" @submit.prevent="propose">
      <div class="calendar-hours"><label>开始时间<select v-model.number="config.startHour" aria-label="开始时间"><option v-for="h in 24" :key="h" :value="h-1">{{String(h-1).padStart(2,'0')}}:00</option></select></label><label>结束时间<select v-model.number="config.endHour" aria-label="结束时间"><option v-for="h in 24" :key="h" :value="h">{{String(h).padStart(2,'0')}}:00</option></select></label></div>
      <fieldset><legend>节假日</legend><div class="date-entry"><input v-model="holiday" type="date" min="2000-01-01" max="2099-12-31" aria-label="节假日日期"/><button type="button" class="icon-button" title="添加节假日" aria-label="添加节假日" :disabled="!holiday||busy" @click="addDate('holidays')"><Plus :size="18"/></button></div><ul class="date-list"><li v-for="date in config.holidays" :key="date"><span>{{date}}</span><button type="button" class="icon-button" :title="`移除节假日 ${date}`" :aria-label="`移除节假日 ${date}`" @click="config.holidays=config.holidays.filter(d=>d!==date)"><Trash2 :size="16"/></button></li></ul></fieldset>
      <fieldset><legend>调休工作日</legend><div class="date-entry"><input v-model="workday" type="date" min="2000-01-01" max="2099-12-31" aria-label="调休日期"/><button type="button" class="icon-button" title="添加调休工作日" aria-label="添加调休工作日" :disabled="!workday||busy" @click="addDate('workdays')"><Plus :size="18"/></button></div><ul class="date-list"><li v-for="date in config.workdays" :key="date"><span>{{date}}</span><button type="button" class="icon-button" :title="`移除调休日期 ${date}`" :aria-label="`移除调休日期 ${date}`" @click="config.workdays=config.workdays.filter(d=>d!==date)"><Trash2 :size="16"/></button></li></ul></fieldset>
      <label>日历变更原因<textarea v-model="reason" required maxlength="500" rows="2"/></label><ContentBoundary v-model="safe"/>
      <button class="primary" :disabled="busy||!safe||!reason.trim()"><Send :size="16"/>提交日历审批</button>
    </form>
    <div class="detail-section"><h3>日历审批记录</h3><label>日历复核意见<textarea v-model="reviewReason" maxlength="500" rows="2"/></label><ContentBoundary v-model="reviewSafe"/>
      <div v-for="p in proposals" :key="p.id" class="detail-section"><strong>{{p.status==='PENDING'?'待复核':p.status==='APPROVED'?'已批准':'已拒绝'}} · 基于 V{{p.expected_version}}</strong><p>{{p.reason}}</p>
        <details><summary>查看日历提案</summary><p>{{p.config.startHour}}:00–{{p.config.endHour}}:00 · {{p.config.timeZone}}</p><p class="dates">节假日：{{p.config.holidays.join('、')||'无'}}</p><p class="dates">调休工作日：{{p.config.workdays.join('、')||'无'}}</p></details><p v-if="p.review_reason">{{p.review_reason}}</p>
        <div v-if="p.status==='PENDING'&&p.proposed_by!==user.id" class="form-footer"><button class="secondary" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review(p,'REJECT')"><X :size="16"/>拒绝日历</button><button class="primary" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review(p,'APPROVE')"><Check :size="16"/>批准日历</button></div>
      </div><p v-if="!proposals.length" class="muted">暂无日历变更</p>
    </div>
    <details class="detail-section"><summary>已生效日历历史</summary><div v-for="v in history" :key="v.version" class="detail-section"><strong>V{{v.version}} · {{v.approved?'已批准':'试行'}}</strong><p>{{v.config.startHour}}:00–{{v.config.endHour}}:00 · {{v.config.timeZone}}</p><p class="dates">节假日：{{v.config.holidays.join('、')||'无'}}</p><p class="dates">调休工作日：{{v.config.workdays.join('、')||'无'}}</p></div></details>
  </section>
</template>
<style scoped>
.calendar-hours{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.date-entry{display:flex;align-items:center;gap:8px;max-width:320px}.date-entry input{min-width:0;flex:1}.date-list{padding:0;margin:8px 0;list-style:none;display:flex;flex-wrap:wrap;gap:8px 20px}.date-list li{display:flex;align-items:center;gap:4px}.dates{overflow-wrap:anywhere}
@media(max-width:760px){.calendar-hours{gap:8px}.date-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.date-list li{font-size:12px;min-width:0}.date-list .icon-button{width:32px;height:32px;flex-shrink:0}}
</style>
