<script setup lang="ts">
import { computed,onMounted,onUnmounted,ref } from 'vue';
import { ArrowLeft,Check,ChevronLeft,ChevronRight,ClipboardCheck,LoaderCircle,PackageCheck,RefreshCw } from 'lucide-vue-next';
import type { RequestDeliveryItem,RequestDeliveryList,RequestDeliveryOperation,RequestDeliveryReceipt } from '@itsm/contracts';
import { api,ApiError,errorText } from '../api';
import { formatDate } from '../labels';
import { createRequestKey } from '../request-key';
import ContentBoundary from './ContentBoundary.vue';

const emit=defineEmits<{back:[];open:[id:string]}>();
const data=ref<RequestDeliveryList>(),group=ref(''),page=ref(1),selected=ref(''),loading=ref(false),busy=ref(false);
const error=ref(''),submittedReceiptId=ref(''),reference=ref(''),safe=ref(false),confirmed=ref(false);
const item=computed(()=>data.value?.items.find(row=>row.approvalId===selected.value));
const pages=computed(()=>Math.max(1,Math.ceil((data.value?.total??0)/20)));
const receiptLabels={PENDING:'等待后台核验',SUCCEEDED:'核验通过，操作已记录',REJECTED:'未执行，核验未通过'};
function receiptLabel(receipt:RequestDeliveryReceipt){
  return receipt.state==='REJECTED'&&receipt.operation==='DELIVER'?'登记未通过，需核查实际授权':receiptLabels[receipt.state];
}
const notice=computed(()=>{
  const receipt=item.value?.command;
  if(!receipt||receipt.id!==submittedReceiptId.value)return '';
  return receipt.state==='PENDING'?'操作请求已提交，等待后台核验。':`${receiptLabel(receipt)}。`;
});
const reasons:Record<string,string>={FULFILLMENT_OPERATOR_DENIED:'当前岗位或人员资格已失效',FULFILLMENT_APPROVAL_UNAVAILABLE:'审批凭据失效或已过期',
  FULFILLMENT_PROVIDER_NOT_APPROVED:'OA 审批结果或申请绑定不匹配',FULFILLMENT_NOT_READY:'交付任务已变化或超时',
  FULFILLMENT_VERSION_CONFLICT:'任务版本已变化',REQUEST_DELIVERY_COMMAND_EXPIRED:'操作请求已超时',
  TICKET_NOT_AWAITING_APPROVAL:'工单状态已变化',APPROVAL_PERSON_UNAVAILABLE:'申请或审批人员身份失效',
  APPROVAL_IDENTITY_CHANGED:'企业身份已变化',APPROVAL_MANAGER_CHANGED:'主管映射已变化',APPROVAL_REQUEST_CHANGED:'原申请内容已变化',
  DELIVERY_VERIFICATION_FAILED:'OA 查询或后台核验失败'};
let attempt:{signature:string;key:string}|undefined;
function reset(){reference.value='';safe.value=false;confirmed.value=false;attempt=undefined;}
function choose(row:RequestDeliveryItem){selected.value=row.approvalId;error.value='';submittedReceiptId.value='';reset();}
async function load(){
  if(loading.value||busy.value)return;
  loading.value=true;error.value='';
  try{data.value=await api<RequestDeliveryList>(`/fulfillments/intake?group=${encodeURIComponent(group.value)}&page=${page.value}`);}
  catch(e){data.value=undefined;error.value=errorText(e);}finally{loading.value=false;}
}
async function act(operation:RequestDeliveryOperation){
  const row=item.value;
  if(!row||busy.value||loading.value||!safe.value||(operation==='PREPARE'?!row.canPrepare:!row.canDeliver||!confirmed.value))return;
  const body=operation==='PREPARE'?{expectedVersion:0,contentClass:'GENERAL'}:
    {expectedVersion:row.version,reference:reference.value,actualDeliveryConfirmed:true,contentClass:'GENERAL'};
  const signature=JSON.stringify({id:row.approvalId,operation,...body});
  if(attempt?.signature!==signature)attempt={signature,key:createRequestKey()};
  busy.value=true;error.value='';submittedReceiptId.value='';
  try{
    const receipt=await api<RequestDeliveryReceipt>(`/fulfillments/intake/${row.approvalId}/${operation==='PREPARE'?'prepare':'deliver'}`,{method:'POST',key:attempt.key,body});
    submittedReceiptId.value=receipt.id;reset();
    data.value=await api<RequestDeliveryList>(`/fulfillments/intake?group=${encodeURIComponent(group.value)}&page=${page.value}`);
  }catch(e){error.value=errorText(e);if(e instanceof ApiError&&[403,404,409].includes(e.status)){attempt=undefined;data.value=undefined;}}
  finally{busy.value=false;}
}
let polling:ReturnType<typeof setInterval>|undefined;
onMounted(()=>{
  void load();
  polling=setInterval(()=>{if(data.value?.items.some(row=>row.command?.state==='PENDING'))void load();},3000);
});
onUnmounted(()=>clearInterval(polling));
</script>

<template>
  <section class="delivery-intake" aria-label="准备与首次交付" :aria-busy="busy||loading">
    <div class="section-heading"><button :disabled="busy||loading" @click="emit('back')"><ArrowLeft :size="16"/>返回交付与回收</button><button class="icon-button" title="刷新准备与交付" aria-label="刷新准备与交付" :disabled="busy||loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p><p v-if="notice" class="delivery-notice" role="status">{{notice}}</p>
    <p v-if="loading" class="muted">正在加载任务</p>
    <p v-else-if="data&&!data.enabled" class="delivery-notice" role="status">首次交付暂未开放</p>
    <label class="delivery-group">责任组<select v-model="group" :disabled="busy||loading" @change="page=1;selected='';load()"><option value="">我的全部支持组</option><option v-for="g in data?.groups??[]" :key="g.id" :value="g.id">{{g.name}}</option></select></label>
    <div v-if="data&&!loading" class="table-wrap"><table><thead><tr><th>工单 / 服务</th><th>申请人 / 责任组</th><th>交付</th><th>操作请求</th></tr></thead><tbody><tr v-for="row in data.items" :key="row.approvalId"><td><button class="ticket-link" @click="choose(row)"><span>{{row.number}}</span><strong>{{row.subject}}</strong></button><small>{{row.serviceName}}</small></td><td>{{row.requesterName}}<small>{{row.groupName}}</small></td><td>{{row.taskState==='READY'?'待实际交付':row.taskState==='BLOCKED'?'交付阻断':row.taskState?'已登记交付':'尚未准备'}}<small v-if="row.assigneeName">{{row.assigneeName}}</small></td><td>{{row.command?receiptLabel(row.command):'-'}}</td></tr></tbody></table><div v-if="!data.items.length" class="empty-state"><ClipboardCheck :size="28"/><p>暂无准备与交付任务</p></div></div>
    <div v-if="data&&pages>1" class="delivery-pagination"><button class="icon-button" title="上一页" aria-label="上一页准备任务" :disabled="page<=1||loading||busy" @click="page--;selected='';load()"><ChevronLeft :size="17"/></button><span>{{page}} / {{pages}}</span><button class="icon-button" title="下一页" aria-label="下一页准备任务" :disabled="page>=pages||loading||busy" @click="page++;selected='';load()"><ChevronRight :size="17"/></button></div>
    <section v-if="item" class="delivery-operation" aria-label="准备与交付操作">
      <div class="section-heading"><h2>{{item.subject}}</h2><button @click="emit('open',item.ticketId)">查看工单</button></div>
      <dl><div><dt>首次交付截止</dt><dd>{{formatDate(item.deadline)}}</dd></div><div><dt>当前交付人</dt><dd>{{item.assigneeName??'尚未领取'}}</dd></div></dl>
      <section v-if="item.command" class="delivery-receipt" aria-label="操作请求回执"><strong>{{receiptLabel(item.command)}}</strong><span>{{item.command.operation==='PREPARE'?'准备任务':'登记实际交付'}} · {{formatDate(item.command.completedAt??item.command.createdAt)}}</span><span v-if="item.command.errorCode">{{reasons[item.command.errorCode]??'操作条件已变化，请核对后重新提交'}}</span></section>
      <form v-if="item.canPrepare||item.canDeliver" @submit.prevent="act(item?.canPrepare?'PREPARE':'DELIVER')">
        <label v-if="item.canDeliver">外部执行记录编号<input v-model="reference" required pattern="[A-Za-z0-9][A-Za-z0-9._/-]{2,99}" maxlength="100" :disabled="busy||loading"/></label>
        <label v-if="item.canDeliver" class="checkbox-label"><input v-model="confirmed" type="checkbox" :disabled="busy||loading"/>已在目标系统实际完成交付，并核对上述记录</label>
        <ContentBoundary v-model="safe" :disabled="busy||loading"/>
        <div class="form-actions"><button type="submit" class="primary" :disabled="busy||loading||!safe||(item.canDeliver&&(!confirmed||!reference))"><LoaderCircle v-if="busy" :size="16" class="spin"/><PackageCheck v-else-if="item.canPrepare" :size="16"/><Check v-else :size="16"/>{{item.canPrepare?'领取准备任务':'提交实际交付记录'}}</button></div>
      </form>
      <p v-else class="muted">当前无可执行操作</p>
    </section>
  </section>
</template>

<style scoped>
.delivery-intake{min-width:0}.delivery-group{display:grid;gap:8px;font-size:12px;max-width:320px;margin:20px 0}.delivery-intake table{width:100%;table-layout:fixed}.delivery-intake th,.delivery-intake td{vertical-align:top;overflow-wrap:anywhere}.delivery-intake small{display:block;margin-top:6px;color:#65747c}.delivery-intake .ticket-link{min-width:0;overflow-wrap:anywhere}.delivery-notice{padding:12px;border-left:3px solid #147e76;background:#edf8f4;color:#245c47;font-size:13px;margin:16px 0}.delivery-operation{margin-top:24px;padding-top:20px;border-top:1px solid #dfe5e8}.delivery-operation h2{font-size:16px;overflow-wrap:anywhere}.delivery-operation dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;font-size:13px;margin:20px 0}.delivery-operation dt{color:#65747c;margin-bottom:8px}.delivery-operation dd{margin:0;overflow-wrap:anywhere}.delivery-receipt{display:grid;gap:8px;font-size:13px;margin:20px 0}.delivery-receipt span{color:#65747c}.delivery-operation form{max-width:580px}.delivery-operation form>label{display:grid;gap:8px}.delivery-operation form>.checkbox-label{display:flex;align-items:start;line-height:1.7;font-size:13px}.delivery-operation input[type=checkbox]{flex:none;width:16px;height:16px;margin-top:4px}.delivery-pagination{display:flex;justify-content:end;align-items:center;gap:12px;font-size:12px;margin-top:18px}@media(max-width:760px){.delivery-intake th,.delivery-intake td{padding:10px 5px;font-size:11px}.delivery-intake .ticket-link strong{font-size:12px}.delivery-operation dl{grid-template-columns:minmax(0,1fr)}.delivery-operation>.section-heading{align-items:start;gap:12px}.delivery-group{max-width:100%}}
</style>
