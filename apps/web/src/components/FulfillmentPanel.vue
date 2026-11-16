<script setup lang="ts">
import { computed,onMounted,ref } from 'vue';
import { ArrowLeft,Check,ChevronLeft,ChevronRight,ClipboardCheck,LoaderCircle,RefreshCw,ShieldOff } from 'lucide-vue-next';
import type { FulfillmentAction,FulfillmentDetail,FulfillmentList,FulfillmentQueue,FulfillmentState } from '@itsm/contracts';
import { api,ApiError,errorText } from '../api';
import { formatDate } from '../labels';
import { createRequestKey } from '../request-key';
import ContentBoundary from './ContentBoundary.vue';

const emit=defineEmits<{open:[id:string]}>();
const queue=ref<FulfillmentQueue>('UNREVIEWED'),group=ref(''),page=ref(1),data=ref<FulfillmentList>(),detail=ref<FulfillmentDetail>();
const loading=ref(false),busy=ref(false),error=ref(''),notice=ref(''),reference=ref(''),safe=ref(false),confirmed=ref(false);
const operation=ref<FulfillmentAction>('REVIEW');
const labels:Record<FulfillmentState,string>={READY:'待交付',DELIVERED:'已交付',REVOKE_DUE:'待回收',REVOKED:'已登记回收',BLOCKED:'交付阻断'};
const eventLabels:Record<string,string>={TASK_PREPARED:'准备交付',DELIVERY_RECORDED:'登记实际交付',DELIVERY_REVIEWED:'独立复核',REVOCATION_REQUIRED:'产生回收义务',REVOCATION_RECORDED:'登记实际回收',TASK_BLOCKED:'阻断交付'};
const tabs:{key:FulfillmentQueue;label:string;count:'unreviewed'|'revokeDue'|'all'}[]=[{key:'UNREVIEWED',label:'待复核',count:'unreviewed'},{key:'REVOKE_DUE',label:'待回收',count:'revokeDue'},{key:'ALL',label:'全部',count:'all'}];
const pages=computed(()=>Math.max(1,Math.ceil((data.value?.total??0)/20)));
const actionable=computed(()=>detail.value&&(operation.value==='REVIEW'?detail.value.canReview:detail.value.canRevoke));
let attempt:{signature:string;key:string}|undefined;
function reset(){reference.value='';safe.value=false;confirmed.value=false;attempt=undefined;}
async function load(){
  if(loading.value||busy.value)return;
  loading.value=true;error.value='';data.value=undefined;
  try{data.value=await api<FulfillmentList>(`/fulfillments?queue=${queue.value}&group=${encodeURIComponent(group.value)}&page=${page.value}`);}
  catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
async function show(id:string){
  if(loading.value||busy.value)return;
  loading.value=true;error.value='';notice.value='';detail.value=undefined;reset();
  try{detail.value=await api<FulfillmentDetail>(`/fulfillments/${id}`);operation.value=detail.value.canReview?'REVIEW':'REVOKE';}
  catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
function select(value:FulfillmentQueue){if(value===queue.value)return;queue.value=value;page.value=1;notice.value='';void load();}
function changeGroup(){page.value=1;notice.value='';void load();}
async function back(){detail.value=undefined;reset();await load();}
async function act(){
  const task=detail.value;
  if(!task||!actionable.value||!safe.value||(operation.value==='REVOKE'&&!confirmed.value)||busy.value)return;
  const body={expectedVersion:task.version,reference:reference.value,contentClass:'GENERAL'};
  const signature=JSON.stringify({id:task.id,operation:operation.value,...body});
  if(attempt?.signature!==signature)attempt={signature,key:createRequestKey()};
  busy.value=true;error.value='';notice.value='';
  try{
    await api(`/fulfillments/${task.id}/${operation.value==='REVIEW'?'review':'revoke'}`,{method:'POST',key:attempt.key,body});
    detail.value=await api<FulfillmentDetail>(`/fulfillments/${task.id}`);
    notice.value=operation.value==='REVIEW'?'独立复核已记录。':'实际回收结果已登记。';reset();
    operation.value=detail.value.canReview?'REVIEW':'REVOKE';
  }catch(e){
    error.value=errorText(e);
    if(e instanceof ApiError&&[403,404,409].includes(e.status)){
      attempt=undefined;
      try{detail.value=await api<FulfillmentDetail>(`/fulfillments/${task.id}`);}catch{detail.value=undefined;}
    }
  }finally{busy.value=false;}
}
onMounted(()=>void load());
</script>

<template>
  <section class="fulfillment-panel" aria-label="交付与回收工作台" :aria-busy="loading||busy">
    <p v-if="error" class="error-banner" role="alert">{{error}}</p><p v-if="notice" class="fulfillment-notice" role="status">{{notice}}</p>
    <div class="section-heading">
      <button v-if="detail" :disabled="busy||loading" @click="back"><ArrowLeft :size="16"/>返回列表</button>
      <span v-else class="muted">{{data?.total??0}} 项</span>
      <button class="icon-button" title="刷新交付任务" aria-label="刷新交付任务" :disabled="busy||loading" @click="detail?show(detail.id):load()"><RefreshCw :size="18" :class="{spin:loading}"/></button>
    </div>
    <p v-if="loading" class="muted" role="status">正在加载任务</p>
    <template v-if="detail">
      <section aria-label="交付任务详情" class="fulfillment-detail">
        <div class="section-heading"><button class="ticket-link" @click="emit('open',detail.ticketId)"><span>{{detail.number}}</span><strong>{{detail.subject}}</strong></button><span class="status">{{labels[detail.state]}}</span></div>
        <dl class="fulfillment-facts"><div><dt>服务</dt><dd>{{detail.serviceName}}</dd></div><div><dt>责任组</dt><dd>{{detail.groupName}}</dd></div><div><dt>申请人</dt><dd>{{detail.requesterName}}</dd></div><div><dt>原交付人</dt><dd>{{detail.assigneeName}}</dd></div><div><dt>实际交付时间</dt><dd>{{detail.deliveredAt?formatDate(detail.deliveredAt):'未交付'}}</dd></div><div><dt>访问截止时间</dt><dd>{{detail.accessExpiresAt?formatDate(detail.accessExpiresAt):'未设置'}}</dd></div><div><dt>独立复核</dt><dd>{{detail.reviewedAt?`${detail.reviewerName} · ${formatDate(detail.reviewedAt)}`:'待完成'}}</dd></div><div><dt>回收登记</dt><dd>{{detail.revokedAt?formatDate(detail.revokedAt):'未登记'}}</dd></div></dl>
        <form v-if="detail.canReview||detail.canRevoke" class="action-form fulfillment-action" @submit.prevent="act">
          <label v-if="detail.canReview&&detail.canRevoke">处理事项<select v-model="operation" :disabled="busy" @change="reset"><option value="REVIEW">独立复核</option><option value="REVOKE">登记实际回收</option></select></label>
          <h2 v-else>{{detail.canReview?'独立复核':'登记实际回收'}}</h2>
          <label>外部执行记录编号<input v-model="reference" required pattern="[A-Za-z0-9][A-Za-z0-9._/-]{2,99}" maxlength="100" :disabled="busy" autocomplete="off"/></label>
          <label v-if="operation==='REVOKE'" class="checkbox-label"><input v-model="confirmed" type="checkbox" required :disabled="busy"/>已在目标系统实际完成撤权，并核对上述记录</label>
          <ContentBoundary v-model="safe"/>
          <div><button class="primary" :disabled="busy||!safe||!reference||!actionable||(operation==='REVOKE'&&!confirmed)"><LoaderCircle v-if="busy" class="spin" :size="16"/><Check v-else-if="operation==='REVIEW'" :size="16"/><ShieldOff v-else :size="16"/>{{operation==='REVIEW'?'确认独立复核':'登记实际回收'}}</button></div>
        </form>
        <p v-else class="muted">当前无可执行操作</p>
      </section>
      <section class="fulfillment-history" aria-label="交付处理记录"><h2>处理记录</h2><p v-if="detail.eventsHasMore" class="muted">仅显示最近 100 条记录，完整历史保留在审计库。</p><ol><li v-for="event in detail.events" :key="event.id"><strong>{{eventLabels[event.action]??'状态更新'}}</strong><span>{{event.actorName??'系统'}} · {{formatDate(event.createdAt)}}</span><span>{{labels[event.toState]}}</span><code v-if="event.reference">{{event.reference}}</code></li></ol><p v-if="!detail.events.length" class="muted">暂无处理记录</p></section>
    </template>
    <template v-else-if="!loading">
      <div class="fulfillment-filters"><div role="tablist" aria-label="交付任务队列" class="segmented"><button v-for="tab in tabs" :key="tab.key" role="tab" :aria-selected="queue===tab.key" :class="{selected:queue===tab.key}" :disabled="busy||loading" @click="select(tab.key)">{{tab.label}} <span>{{data?.counts[tab.count]??0}}</span></button></div><label>责任组<select v-model="group" :disabled="busy||loading" @change="changeGroup"><option value="">我的全部支持组</option><option v-for="item in data?.groups??[]" :key="item.id" :value="item.id">{{item.name}}</option></select></label></div>
      <div class="table-wrap fulfillment-table"><table><thead><tr><th>工单 / 服务</th><th>责任组 / 交付人</th><th>状态</th><th>访问截止</th><th>复核</th></tr></thead><tbody><tr v-for="item in data?.items??[]" :key="item.id"><td><button class="ticket-link" @click="show(item.id)"><span>{{item.number}}</span><strong>{{item.subject}}</strong></button><small>{{item.serviceName}}</small></td><td>{{item.groupName}}<small>{{item.assigneeName}}</small></td><td><span class="status">{{labels[item.state]}}</span></td><td>{{item.accessExpiresAt?formatDate(item.accessExpiresAt):'未设置'}}</td><td>{{item.reviewedAt?'已复核':'未复核'}}</td></tr></tbody></table><div v-if="!data?.items.length&&!error" class="empty-state"><ClipboardCheck :size="28"/><p>当前队列暂无任务</p></div></div>
      <div v-if="data&&pages>1" class="fulfillment-pagination"><button class="icon-button" title="上一页" aria-label="上一页交付任务" :disabled="page<=1||loading" @click="page--;load()"><ChevronLeft :size="17"/></button><span>{{page}} / {{pages}}</span><button class="icon-button" title="下一页" aria-label="下一页交付任务" :disabled="page>=pages||loading" @click="page++;load()"><ChevronRight :size="17"/></button></div>
    </template>
  </section>
</template>

<style scoped>
.fulfillment-panel{min-width:0}.fulfillment-filters{display:flex;align-items:end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:18px 0}.fulfillment-filters label{display:grid;gap:7px;font-size:12px;max-width:100%}.fulfillment-table table{width:100%;table-layout:fixed}.fulfillment-table th:first-child{width:32%}.fulfillment-table th,.fulfillment-table td{overflow-wrap:anywhere;vertical-align:top}.fulfillment-table small{display:block;color:#65747c;margin-top:6px}.fulfillment-detail,.fulfillment-history{margin-top:24px;padding-top:20px;border-top:1px solid #dfe5e8;min-width:0}.fulfillment-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:24px 0}.fulfillment-facts dt{font-size:12px;color:#65747c;margin-bottom:6px}.fulfillment-facts dd{margin:0;font-size:13px;overflow-wrap:anywhere}.fulfillment-detail .ticket-link{min-width:0;overflow-wrap:anywhere}.fulfillment-action{max-width:580px}.fulfillment-action>label{display:grid;gap:8px}.fulfillment-action>.checkbox-label{display:flex;align-items:start;font-size:13px;line-height:1.7}.fulfillment-action input[type=checkbox]{width:16px;height:16px;flex:none;margin-top:4px}.fulfillment-history ol{padding:0;list-style:none}.fulfillment-history li{display:flex;gap:8px 16px;flex-wrap:wrap;padding:14px 0;border-bottom:1px solid #edf0f2;font-size:12px;overflow-wrap:anywhere}.fulfillment-history li span{color:#65747c}.fulfillment-history code{max-width:100%;overflow-wrap:anywhere}.fulfillment-pagination{display:flex;align-items:center;justify-content:end;gap:12px;margin-top:18px;font-size:12px}.fulfillment-notice{padding:12px;border-left:3px solid #147e76;background:#edf8f4;color:#245c47;font-size:13px;margin-bottom:16px}@media(max-width:760px){.fulfillment-facts{grid-template-columns:minmax(0,1fr);gap:16px}.fulfillment-table th,.fulfillment-table td{font-size:11px;padding:10px 5px}.fulfillment-table .ticket-link strong{font-size:12px}.fulfillment-filters{align-items:stretch}.fulfillment-filters .segmented{display:flex;max-width:100%;flex-wrap:wrap}.fulfillment-filters .segmented button{padding:8px}.fulfillment-filters label{width:100%}.fulfillment-detail>.section-heading{align-items:start;gap:12px}.fulfillment-detail .status{flex:none;font-size:11px}}
</style>
