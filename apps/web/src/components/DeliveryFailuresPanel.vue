<script setup lang="ts">
import { computed,onMounted,ref } from 'vue';
import { ArrowLeft,Check,ChevronLeft,ChevronRight,ClipboardCheck,LoaderCircle,RefreshCw } from 'lucide-vue-next';
import type { DeliveryFailureItem,DeliveryFailureList,DeliveryFailureOutcome } from '@itsm/contracts';
import { api,ApiError,errorText } from '../api';
import { formatDate } from '../labels';
import { createRequestKey } from '../request-key';
import ContentBoundary from './ContentBoundary.vue';

const emit=defineEmits<{back:[];open:[id:string]}>();
const data=ref<DeliveryFailureList>(),group=ref(''),page=ref(1),resolved=ref(false),selected=ref('');
const loading=ref(false),busy=ref(false),error=ref(''),notice=ref(''),reference=ref(''),safe=ref(false),confirmed=ref(false);
const outcome=ref<DeliveryFailureOutcome>('NOT_GRANTED');
const item=computed(()=>data.value?.items.find(row=>row.id===selected.value));
const pages=computed(()=>Math.max(1,Math.ceil((data.value?.total??0)/20)));
const labels:Record<DeliveryFailureOutcome,string>={NOT_GRANTED:'已核实未产生授权',REVOKED:'已核实实际撤权'};
let attempt:{signature:string;key:string}|undefined;
function reset(){reference.value='';safe.value=false;confirmed.value=false;outcome.value='NOT_GRANTED';attempt=undefined;}
function choose(row:DeliveryFailureItem){if(busy.value||loading.value)return;selected.value=row.id;error.value='';notice.value='';reset();}
async function load(){
  if(loading.value||busy.value)return;
  loading.value=true;error.value='';
  try{data.value=await api<DeliveryFailureList>(`/fulfillments/delivery-failures?group=${encodeURIComponent(group.value)}&page=${page.value}&resolved=${resolved.value}`);}
  catch(e){data.value=undefined;error.value=errorText(e);}finally{loading.value=false;}
}
function filter(){page.value=1;selected.value='';notice.value='';reset();void load();}
function select(value:boolean){if(resolved.value===value)return;resolved.value=value;filter();}
async function act(){
  const row=item.value;
  if(!row?.canResolve||!safe.value||!confirmed.value||!reference.value||busy.value||loading.value)return;
  const body={outcome:outcome.value,reference:reference.value,actualVerificationConfirmed:true,contentClass:'GENERAL'};
  const signature=JSON.stringify({id:row.id,...body});
  if(attempt?.signature!==signature)attempt={signature,key:createRequestKey()};
  busy.value=true;error.value='';notice.value='';
  try{
    await api(`/fulfillments/delivery-failures/${row.id}/resolve`,{method:'POST',key:attempt.key,body});
    notice.value='独立核查结果已记录。';reset();selected.value='';
  }catch(e){error.value=errorText(e);if(e instanceof ApiError&&[403,404,409].includes(e.status)){attempt=undefined;data.value=undefined;}}
  finally{busy.value=false;}
  if(notice.value)await load();
}
onMounted(()=>void load());
</script>

<template>
  <section class="delivery-failures" aria-label="交付登记失败核查" :aria-busy="busy||loading">
    <div class="section-heading"><button :disabled="busy||loading" @click="emit('back')"><ArrowLeft :size="16"/>返回交付与回收</button><button class="icon-button" title="刷新核查队列" aria-label="刷新核查队列" :disabled="busy||loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p><p v-if="notice" role="status" class="verification-notice">{{notice}}</p>
    <div class="verification-filters"><div role="tablist" aria-label="核查队列" class="segmented"><button role="tab" :aria-selected="!resolved" :class="{selected:!resolved}" :disabled="busy||loading" @click="select(false)">待核查</button><button role="tab" :aria-selected="resolved" :class="{selected:resolved}" :disabled="busy||loading" @click="select(true)">已核查</button></div><label>责任组<select v-model="group" :disabled="busy||loading" @change="filter"><option value="">我的全部支持组</option><option v-for="g in data?.groups??[]" :key="g.id" :value="g.id">{{g.name}}</option></select></label></div>
    <p v-if="loading" class="muted">正在加载核查记录</p>
    <div v-else-if="data" class="table-wrap"><table><thead><tr><th>工单</th><th>责任组 / 登记人</th><th>登记失败时间</th><th>核查结果</th></tr></thead><tbody><tr v-for="row in data.items" :key="row.id"><td><button class="ticket-link" @click="choose(row)"><span>{{row.number}}</span><strong>{{row.subject}}</strong></button></td><td>{{row.groupName}}<small>{{row.operatorName}}</small></td><td>{{formatDate(row.failedAt)}}</td><td>{{row.resolution?labels[row.resolution.outcome]:'需核查实际授权'}}</td></tr></tbody></table><div v-if="!data.items.length" class="empty-state"><ClipboardCheck :size="28"/><p>当前队列暂无记录</p></div></div>
    <div v-if="data&&pages>1" class="verification-pagination"><button class="icon-button" title="上一页" aria-label="上一页核查记录" :disabled="page<=1||loading||busy" @click="page--;selected='';load()"><ChevronLeft :size="17"/></button><span>{{page}} / {{pages}}</span><button class="icon-button" title="下一页" aria-label="下一页核查记录" :disabled="page>=pages||loading||busy" @click="page++;selected='';load()"><ChevronRight :size="17"/></button></div>
    <section v-if="item" class="verification-detail" aria-label="交付失败核查操作"><div class="section-heading"><h2>{{item.subject}}</h2><button @click="emit('open',item.ticketId)">查看工单</button></div>
      <dl><div><dt>原交付登记编号</dt><dd>{{item.reference}}</dd></div><div><dt>登记人</dt><dd>{{item.operatorName}}</dd></div></dl>
      <template v-if="item.resolution"><strong>{{labels[item.resolution.outcome]}}</strong><dl><div><dt>独立核查人</dt><dd>{{item.resolution.verifierName}}</dd></div><div><dt>核查时间</dt><dd>{{formatDate(item.resolution.resolvedAt)}}</dd></div><div><dt>核查记录编号</dt><dd>{{item.resolution.reference}}</dd></div></dl></template>
      <form v-else-if="item.canResolve" @submit.prevent="act"><label>核查结果<select v-model="outcome" :disabled="busy||loading"><option value="NOT_GRANTED">已核实未产生授权</option><option value="REVOKED">已核实实际撤权</option></select></label><label>外部核查记录编号<input v-model="reference" required pattern="[A-Za-z0-9][A-Za-z0-9._/-]{2,99}" maxlength="100" :disabled="busy||loading"/></label><label class="checkbox-label"><input v-model="confirmed" type="checkbox" :disabled="busy||loading"/>已在目标系统独立核查，确认本次未留存有效授权</label><ContentBoundary v-model="safe" :disabled="busy||loading"/><div class="form-actions"><button type="submit" class="primary" :disabled="busy||loading||!safe||!confirmed||!reference"><LoaderCircle v-if="busy" :size="16" class="spin"/><Check v-else :size="16"/>登记独立核查结果</button></div></form>
      <p v-else class="muted">当前无可执行操作</p>
    </section>
  </section>
</template>

<style scoped>
.delivery-failures{min-width:0}.verification-filters{display:flex;align-items:end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:20px 0}.verification-filters label,.verification-detail form>label{display:grid;gap:8px;font-size:13px}.verification-filters label{max-width:320px;min-width:180px}.delivery-failures table{width:100%;table-layout:fixed}.delivery-failures td,.delivery-failures th{vertical-align:top;overflow-wrap:anywhere}.delivery-failures small{display:block;margin-top:6px;color:#65747c}.delivery-failures .ticket-link{min-width:0;overflow-wrap:anywhere}.verification-notice{padding:12px;border-left:3px solid #147e76;background:#edf8f4;color:#245c47;font-size:13px}.verification-detail{margin-top:24px;padding-top:20px;border-top:1px solid #dfe5e8}.verification-detail h2{font-size:16px;overflow-wrap:anywhere}.verification-detail dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;font-size:13px;margin:20px 0}.verification-detail dt{color:#65747c;margin-bottom:8px}.verification-detail dd{margin:0;overflow-wrap:anywhere}.verification-detail form{max-width:580px;display:grid;gap:16px}.verification-detail form>.checkbox-label{display:flex;align-items:start;line-height:1.7}.verification-detail input[type=checkbox]{flex:none;width:16px;height:16px;margin-top:4px}.verification-pagination{display:flex;justify-content:end;align-items:center;gap:12px;margin-top:18px;font-size:12px}@media(max-width:760px){.verification-filters{align-items:stretch}.verification-filters label{max-width:100%;width:100%}.delivery-failures th,.delivery-failures td{padding:10px 5px;font-size:11px}.delivery-failures .ticket-link strong{font-size:12px}.verification-detail dl{grid-template-columns:minmax(0,1fr)}.verification-detail>.section-heading{align-items:start;gap:12px}}
</style>
