<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue';
import { ArrowLeft,Check,Clock3,LoaderCircle,RefreshCw } from 'lucide-vue-next';
import type { Priority,SessionUser,TicketAction,TicketActionInput,TicketView } from '@itsm/contracts';
import { api,errorText,ApiError } from '../api';
import { actions as ticketActions,priorityActions,duration,formatDate,statuses } from '../labels';
import ContentBoundary from './ContentBoundary.vue';
const props=defineProps<{id:string;user:SessionUser}>();
const actions={...ticketActions,...priorityActions};
const emit=defineEmits<{back:[];changed:[]}>();
const ticket=ref<TicketView>(),loading=ref(false),busy=ref(false),error=ref(''),action=ref<TicketAction>(),comment=ref(''),reason=ref(''),dueAt=ref(''),vendorReference=ref(''),vendorOwner=ref(''),category=ref(''),evidence=ref(''),target=ref('');
const groups=ref<{id:string;name:string}[]>([]),key=ref(crypto.randomUUID());
const members=ref<{id:string;name:string}[]>([]),targetPerson=ref(''),membersLoading=ref(false);
const contentSafe=ref(false);
const reviewPriority=ref<Priority>('P1'),reviewReason=ref(''),reviewSafe=ref(false),reviewKey=ref(crypto.randomUUID());
const reviewLabels:Record<string,string>={NOT_REQUIRED:'无需主管确认',PENDING:'候选 · 待主管确认',CONFIRMED:'主管已确认',ADJUSTED:'主管已调整'};
watch([reviewPriority,reviewReason],()=>{reviewKey.value=crypto.randomUUID();reviewSafe.value=false;});
const fieldLabels:Record<string,string>={system:'业务系统',module:'模块 / 页面',location:'所在地点',device:'设备编号'};
watch([comment,reason,dueAt,vendorReference,vendorOwner,category,evidence,target,targetPerson],()=>{key.value=crypto.randomUUID();contentSafe.value=false;});
watch(target,async value=>{
  targetPerson.value='';members.value=[];membersLoading.value=!!value;
  if(!value)return;
  try{const result=await api<{items:{id:string;name:string}[]}>(`/support-groups/${encodeURIComponent(value)}/members`);if(target.value===value)members.value=result.items.filter(person=>person.id!==props.user.id);}
  catch(e){if(target.value===value)error.value=errorText(e);}
  finally{if(target.value===value)membersLoading.value=false;}
});
const isAgent=computed(()=>ticket.value&&props.user.groups.includes(ticket.value.ownerGroupId));
const mine=computed(()=>ticket.value?.requesterId===props.user.id);
const available=computed<TicketAction[]>(()=>{
  if(!ticket.value)return[];const state=ticket.value.status,result:TicketAction[]=[];
  if(mine.value){if(['NEW','QUEUED'].includes(state))result.push('CANCEL');if(state==='WAITING_USER')result.push('ADD_INFO');if(state==='PENDING_CONFIRMATION')result.push('CONFIRM','REOPEN');}
  const active=['QUEUED','IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION'].includes(state);
  if(active&&ticket.value.pendingAssigneeId===props.user.id)result.push('ACCEPT_HANDOVER','DECLINE_HANDOVER');
  if(isAgent.value&&active){
    const owner=ticket.value.assigneeId===props.user.id;
    if(!ticket.value.assigneeId&&!ticket.value.pendingAssigneeId)result.push('ACCEPT');
    if(owner){if(state==='IN_PROGRESS')result.push('REQUEST_INFO','WAIT_VENDOR','RESOLVE');if(state==='WAITING_VENDOR')result.push('RESOLVE');}
    if(owner||(!ticket.value.assigneeId&&state==='QUEUED'))result.push(ticket.value.pendingAssigneeId?'CANCEL_HANDOVER':'REASSIGN');
  }
  return result;
});
const commands:Record<string,string>={ACCEPT:'接单并回复',REQUEST_INFO:'请求补充',ADD_INFO:'补充信息',WAIT_VENDOR:'等待厂商',RESOLVE:'提交解决方案',CONFIRM:'确认已解决',REOPEN:'仍未解决',CANCEL:'撤销报障',REASSIGN:'发起交接',ACCEPT_HANDOVER:'确认接收',DECLINE_HANDOVER:'退回交接',CANCEL_HANDOVER:'撤回交接'};
async function load(){loading.value=true;error.value='';try{ticket.value=await api<TicketView>(`/tickets/${props.id}`);if(props.user.groups.length)groups.value=(await api<{items:{id:string;name:string}[]}>('/support-groups')).items;}catch(e){error.value=errorText(e);}finally{loading.value=false;}}
function choose(value:TicketAction){action.value=value;comment.value='';reason.value='';dueAt.value='';vendorReference.value='';vendorOwner.value='';category.value='';evidence.value='';target.value='';targetPerson.value='';contentSafe.value=false;key.value=crypto.randomUUID();error.value='';}
async function submit(){
  if(!ticket.value||!action.value||busy.value||!contentSafe.value)return;busy.value=true;error.value='';
  const body:TicketActionInput={contentClass:'GENERAL',action:action.value,expectedVersion:ticket.value.version};
  if(comment.value)body.comment=comment.value;if(reason.value)body.reason=reason.value;
  if(dueAt.value)body.dueAt=new Date(dueAt.value).toISOString();
  if(vendorReference.value)body.vendorReference=vendorReference.value;if(vendorOwner.value)body.vendorOwner=vendorOwner.value;
  if(category.value)body.resolutionCategory=category.value;if(evidence.value)body.evidence=evidence.value;if(target.value)body.targetGroupId=target.value;if(targetPerson.value)body.targetAssigneeId=targetPerson.value;
  try{await api(`/tickets/${props.id}/actions`,{method:'POST',body,key:key.value});action.value=undefined;await load();emit('changed');}
  catch(e){if(e instanceof ApiError&&e.status===409){await load();key.value=crypto.randomUUID();}error.value=errorText(e);}finally{busy.value=false;}
}
async function submitPriorityReview(){
  if(!ticket.value||!ticket.value.canReviewPriority||!reviewSafe.value||!reviewReason.value.trim()||busy.value)return;
  busy.value=true;error.value='';
  try{await api(`/tickets/${props.id}/priority-review`,{method:'POST',key:reviewKey.value,body:{contentClass:'GENERAL',expectedVersion:ticket.value.version,priority:reviewPriority.value,reason:reviewReason.value}});
    reviewReason.value='';reviewSafe.value=false;reviewKey.value=crypto.randomUUID();await load();emit('changed');}
  catch(e){if(e instanceof ApiError&&e.status===409){await load();reviewKey.value=crypto.randomUUID();}error.value=errorText(e);}finally{busy.value=false;}
}
onMounted(load);
</script>
<template>
  <section class="detail-page"><button class="text-button" @click="emit('back')"><ArrowLeft :size="17"/> 返回工单列表</button><div v-if="loading&&!ticket" class="empty-state"><LoaderCircle class="spin"/> 正在加载</div><p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <template v-if="ticket"><div class="page-title"><div><p class="eyebrow">{{ticket.number}}</p><h1>{{ticket.subject}}</h1></div><button class="icon-button" title="刷新" aria-label="刷新工单" :disabled="loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button></div><div class="ticket-meta"><span class="status" :data-status="ticket.status">{{statuses[ticket.status]}}</span><span class="priority" :data-priority="ticket.priority">{{ticket.priority}}</span><span>{{formatDate(ticket.createdAt)}}</span><span>责任组：{{groups.find(g=>g.id===ticket?.ownerGroupId)?.name??ticket.ownerGroupId}}</span><span>处理人：{{ticket.assigneeName??ticket.assigneeId??'组内待认领'}}</span><span v-if="ticket.pendingAssigneeId" class="amber-text">待交接：{{ticket.pendingAssigneeName??ticket.pendingAssigneeId}}</span></div>
      <section v-if="ticket.priorityReviewState!=='NOT_REQUIRED'" class="detail-section priority-review" aria-label="P1 优先级确认">
        <div class="section-heading"><h2>P1 优先级确认</h2><span class="status">{{reviewLabels[ticket.priorityReviewState]}}</span></div>
        <p v-if="ticket.priorityReviewedAt" class="muted">{{formatDate(ticket.priorityReviewedAt)}} · {{ticket.priorityReviewedBy}} · 当前 {{ticket.priority}}</p>
        <p v-if="ticket.priorityReviewReason" class="multiline">{{ticket.priorityReviewReason}}</p>
        <p v-if="ticket.sla?.length" class="muted">本轮 SLA：{{ticket.sla[ticket.sla.length-1]?.priority}} · 起算时间及目标不变</p>
        <template v-if="ticket.priorityAlert">
          <p v-if="!ticket.priorityAlert.reviewersAvailable" class="danger-text" role="status">当前责任组没有可用的独立确认人</p>
          <p v-if="ticket.priorityAlert.overdue" class="danger-text" role="status">主管确认已逾期</p>
          <p v-if="ticket.priorityAlert.notificationMode==='disabled'" class="danger-text">P1 通知发送未启用</p>
          <p v-else-if="ticket.priorityAlert.notificationMode==='fake'" class="amber-text">P1 通知：开发模拟，非真实送达</p>
          <p v-if="ticket.priorityAlert.deliveries.DEAD" class="danger-text">{{ticket.priorityAlert.deliveries.DEAD}} 条 P1 通知发送失败</p>
          <p v-if="ticket.priorityAlert.deliveries.PENDING||ticket.priorityAlert.deliveries.SENDING" class="muted">P1 通知发送中</p>
          <p v-if="ticket.priorityAlert.deliveries.DELIVERED" class="muted">平台已确认发送 {{ticket.priorityAlert.deliveries.DELIVERED}} 条 P1 通知</p>
        </template>
        <form v-if="ticket.canReviewPriority" class="action-form" @submit.prevent="submitPriorityReview">
          <label>确认优先级<select v-model="reviewPriority" required><option>P1</option><option>P2</option><option>P3</option><option>P4</option></select></label>
          <label>确认依据<textarea v-model="reviewReason" required maxlength="2000" rows="2"/></label>
          <ContentBoundary v-model="reviewSafe"/><div class="form-footer"><button type="submit" class="primary" :disabled="busy||!reviewSafe||!reviewReason.trim()"><Check :size="16"/>提交优先级确认</button></div>
        </form>
      </section>
      <div class="detail-grid"><div><section class="detail-section"><h2>报障详情</h2><p class="multiline">{{ticket.description}}</p><dl v-if="Object.keys(ticket.fields).length" class="fact-list"><template v-for="(value,name) in ticket.fields" :key="name"><dt>{{fieldLabels[String(name)]??name}}</dt><dd>{{value}}</dd></template></dl></section>
        <section class="detail-section"><div class="section-heading"><h2>处理记录</h2><span class="muted">{{ticket.events?.length??0}} 条</span></div><ol class="timeline"><li v-for="(event,index) in ticket.events??[]" :key="index"><span class="timeline-dot"></span><div class="event-title"><strong>{{actions[event.action]??event.action}}</strong><time>{{formatDate(event.createdAt)}}</time></div><p v-if="event.detail.comment" class="multiline">{{event.detail.comment}}</p><p v-if="event.detail.reason" class="multiline">{{event.detail.reason}}</p><p v-if="event.detail.vendorReference" class="muted">厂商单号：{{event.detail.vendorReference}}</p><p v-if="event.detail.targetGroupId" class="muted">{{event.detail.oldGroupId}} → {{event.detail.targetGroupId}}</p></li></ol></section>
      </div><aside><section class="detail-section sla-section"><h2><Clock3 :size="17"/> 服务时效</h2><div v-for="sla in ticket.sla??[]" :key="sla.cycle" class="sla-cycle"><div class="section-heading"><strong>第 {{sla.cycle}} 轮</strong><span :class="sla.breached?'danger-text':'muted'">{{sla.completed?'已停止':sla.paused?'等待补充，解决计时暂停':sla.breached?'已超时':'计时中'}}</span></div><p>首次响应 <strong>{{duration(sla.responseMinutes)}}</strong> / {{duration(sla.responseTarget)}}</p><p>解决耗时 <strong>{{duration(sla.resolutionMinutes)}}</strong> / {{duration(sla.resolutionTarget)}}</p><p v-if="!sla.responded&&!sla.completed" class="muted">等待人工回复送达</p></div><p v-if="!ticket.sla?.length" class="muted">此工单暂无 SLA 周期。</p><p class="caption">当前使用试点服务日历</p></section>
        <section v-if="available.length" class="detail-section"><h2>处理操作</h2><div class="action-list"><button v-for="value in available" :key="value" class="secondary" :class="{selected:action===value}" @click="choose(value)">{{commands[value]}}</button></div>
          <form v-if="action" class="action-form" @submit.prevent="submit">
            <label v-if="['ACCEPT','ACCEPT_HANDOVER','REQUEST_INFO','ADD_INFO','WAIT_VENDOR','RESOLVE'].includes(action)">{{action==='RESOLVE'?'解决说明':action==='REQUEST_INFO'?'需要补充的内容':'回复内容'}}<textarea v-model="comment" required maxlength="2000" rows="3"/></label>
            <label v-if="['REOPEN','REASSIGN','DECLINE_HANDOVER','CANCEL_HANDOVER'].includes(action)">原因<textarea v-model="reason" required maxlength="2000" rows="3"/></label>
            <template v-if="action==='REASSIGN'">
              <label>目标支持组<select v-model="target" required><option value="">请选择</option><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
              <label>接收人<select v-model="targetPerson" required :disabled="!target||membersLoading"><option value="">{{membersLoading?'正在加载':members.length?'请选择':'暂无可选人员'}}</option><option v-for="person in members" :key="person.id" :value="person.id">{{person.name}}</option></select></label>
            </template>
            <label v-if="action==='REQUEST_INFO'">补充截止时间<input v-model="dueAt" required type="datetime-local"/></label>
            <template v-if="action==='WAIT_VENDOR'"><label>厂商工单号<input v-model="vendorReference" required maxlength="200"/></label><label>跟进负责人<input v-model="vendorOwner" required maxlength="200"/></label></template>
            <template v-if="action==='RESOLVE'"><label>解决分类<select v-model="category" required><option value="">请选择</option><option>配置调整</option><option>故障恢复</option><option>操作指导</option><option>厂商修复</option></select></label><label>验证依据<textarea v-model="evidence" required maxlength="2000" rows="2"/></label></template>
            <ContentBoundary v-model="contentSafe"/><div class="form-footer"><button type="button" class="text-button" :disabled="busy" @click="action=undefined">取消</button><button type="submit" class="primary" :disabled="busy||membersLoading||(action==='REASSIGN'&&!targetPerson)"><LoaderCircle v-if="busy" :size="16" class="spin"/><Check v-else :size="16"/>{{commands[action]}}</button></div>
          </form></section>
      </aside></div>
    </template>
  </section>
</template>
