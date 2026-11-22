<script setup lang="ts">
import {computed,onMounted,ref,toRaw} from 'vue';
import {Ban,Plus,RefreshCw,Send} from 'lucide-vue-next';
import type {ServiceStructure} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import {formatDate} from '../labels';
import ContentBoundary from './ContentBoundary.vue';
type Appointment=ServiceStructure['appointments'][number];
type Person={id:string;name:string;groups:string[]};
type Data={version:number;positions:ServiceStructure['positions'];items:Appointment[];people:Person[];proposals:{id:string;status:string;reason:string;reviewReason:string|null}[]};
const data=ref<Data>(),busy=ref(false),error=ref(''),safe=ref(false),reason=ref('');
const draft=ref<Appointment>(),requestId=ref('');
const position=computed(()=>data.value?.positions.find(p=>p.id===draft.value?.positionId));
const people=computed(()=>data.value?.people.filter(p=>p.groups.includes(position.value?.groupId??''))??[]);
const positionName=(id:string)=>data.value?.positions.find(p=>p.id===id)?.name??id;
const personName=(id:string)=>data.value?.people.find(p=>p.id===id)?.name??id;
const statuses:Record<string,string>={PENDING:'待独立复核',APPROVED:'已批准',REJECTED:'已拒绝'};
const local=(value:string)=>{const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
function date(event:Event,key:'validFrom'|'validTo'){const value=(event.target as HTMLInputElement).value;if(draft.value&&value)draft.value[key]=new Date(value).toISOString();safe.value=false;}
async function load(){busy.value=true;error.value='';try{data.value=await api<Data>('/admin/service-structure/appointments');}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
function edit(item?:Appointment){draft.value=item?structuredClone(toRaw(item)):{id:createRequestKey(),positionId:data.value?.positions.find(p=>p.enabled)?.id??'',employeeId:'',duty:'PRIMARY',validFrom:new Date().toISOString(),validTo:new Date(Date.now()+365*86400000).toISOString(),enabled:true};reason.value='';safe.value=false;requestId.value=createRequestKey();}
async function save(){if(!draft.value||!data.value||!safe.value)return;busy.value=true;error.value='';try{
  await api('/admin/service-structure/appointments',{method:'POST',body:{id:requestId.value,expectedVersion:data.value.version,appointment:draft.value,reason:reason.value,contentClass:'GENERAL'}});
  draft.value=undefined;await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function revoke(){if(!draft.value||!data.value||!safe.value)return;busy.value=true;error.value='';try{
  await api('/admin/service-structure/appointments/revoke',{method:'POST',body:{id:requestId.value,expectedVersion:data.value.version,appointmentId:draft.value.id,reason:reason.value,contentClass:'GENERAL'}});
  draft.value=undefined;await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
onMounted(load);
</script>
<template>
  <section><div class="section-heading"><h2>任职配置</h2><div class="actions"><button class="secondary" :disabled="busy||!data" @click="edit()"><Plus :size="16"/>新增任职</button><button class="icon-button" title="刷新" aria-label="刷新" :disabled="busy" @click="load"><RefreshCw :size="18"/></button></div></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <form v-if="draft&&data" class="appointment-form" @submit.prevent="save"><fieldset :disabled="busy">
      <div class="form-grid"><label>岗位<select v-model="draft.positionId" required @change="draft.employeeId='';safe=false"><option v-for="p in data.positions.filter(p=>p.enabled)" :key="p.id" :value="p.id">{{p.name}}</option></select></label>
      <label>人员<select v-model="draft.employeeId" required @change="safe=false"><option value="">请选择</option><option v-for="p in people" :key="p.id" :value="p.id">{{p.name}} · {{p.id}}</option></select></label>
      <label>值守角色<select v-model="draft.duty" @change="safe=false"><option value="PRIMARY">主责</option><option value="BACKUP">备岗</option></select></label>
      <label>开始时间<input type="datetime-local" :value="local(draft.validFrom)" required @change="date($event,'validFrom')"/></label><label>结束时间<input type="datetime-local" :value="local(draft.validTo)" required @change="date($event,'validTo')"/></label>
      <label class="check-row"><input v-model="draft.enabled" type="checkbox" @change="safe=false"/>启用</label></div>
      <label>变更或撤销原因<textarea v-model="reason" required maxlength="500" rows="2" @input="safe=false"/></label><ContentBoundary v-model="safe"/>
      <div class="actions"><button class="primary" :disabled="!safe||!reason.trim()"><Send :size="16"/>提交独立复核</button><button v-if="data.items.some(a=>a.id===draft!.id&&a.enabled)" type="button" class="secondary" :disabled="!safe||!reason.trim()" @click="revoke"><Ban :size="16"/>立即撤销任职</button><button type="button" class="text-button" @click="draft=undefined">取消</button></div>
    </fieldset></form>
    <div v-if="data" class="table-wrap"><table><thead><tr><th>岗位</th><th>人员</th><th>值守角色</th><th>有效期</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="a in data.items" :key="a.id"><td>{{positionName(a.positionId)}}</td><td>{{personName(a.employeeId)}}</td><td>{{a.duty==='PRIMARY'?'主责':'备岗'}}</td><td>{{formatDate(a.validFrom,true)}} 至 {{formatDate(a.validTo,true)}}</td><td>{{a.enabled?'启用':'停用'}}</td><td><button class="text-button" :disabled="busy" @click="edit(a)">维护</button></td></tr></tbody></table></div>
    <section v-if="data?.proposals.length" class="review-history"><h2>我的变更提案</h2><p v-for="p in data.proposals" :key="p.id">{{statuses[p.status]??p.status}} · {{p.reason}}<span v-if="p.reviewReason"> · {{p.reviewReason}}</span></p></section>
  </section>
</template>
<style scoped>
.section-heading,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.section-heading{justify-content:space-between}.appointment-form{border-block:1px solid #d9e0e8;padding:20px 0;margin:16px 0}fieldset{border:0;padding:0;min-width:0}.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}.check-row{display:flex;align-items:center;gap:8px}.check-row input{width:auto}.review-history{margin-top:24px}
</style>
