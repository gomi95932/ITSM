<script setup lang="ts">
import { computed,onMounted,ref,watch } from 'vue';
import { ArrowLeft,Check,Clock3,LoaderCircle,RefreshCw,Tags } from 'lucide-vue-next';
import { USER_WAIT_REASONS,VENDOR_WAIT_REASONS,type WaitReason,type CatalogItem,type Priority,type SessionUser,type TicketAction,type TicketActionInput,type TicketView } from '@itsm/contracts';
import { api,errorText,ApiError } from '../api';
import { createRequestKey } from '../request-key';
import { actions as ticketActions,priorityActions,continuityActions,duration,formatDate,statuses,waitingReasons } from '../labels';
import ContentBoundary from './ContentBoundary.vue';
import TicketAttachments from './TicketAttachments.vue';
import PriorityPanel from './PriorityPanel.vue';
const props=defineProps<{id:string;user:SessionUser}>();
const actions:Record<string,string>={...ticketActions,...priorityActions,...continuityActions,PRIORITY_CHANGED:'优先级已调整',PRIORITY_SUGGESTED:'提交分级建议'};
const emit=defineEmits<{back:[];changed:[]}>();
const ticket=ref<TicketView>(),loading=ref(false),busy=ref(false),error=ref(''),action=ref<TicketAction>(),comment=ref(''),reason=ref(''),dueAt=ref(''),vendorReference=ref(''),vendorOwner=ref(''),category=ref(''),evidence=ref(''),target=ref('');
const groups=ref<{id:string;name:string}[]>([]),key=ref(createRequestKey());
const members=ref<{id:string;name:string}[]>([]),targetPerson=ref(''),membersLoading=ref(false);
const continuationId=ref('');
const waitingReason=ref<WaitReason|''>('');
const waitingOptions=computed(()=>action.value==='REQUEST_INFO'?USER_WAIT_REASONS:VENDOR_WAIT_REASONS);
const contentSafe=ref(false);
const catalog=ref<CatalogItem[]>([]),correcting=ref(false),classificationCode=ref(''),classificationReason=ref(''),classificationFields=ref<Record<string,string>>({}),classificationSafe=ref(false),classificationKey=ref(createRequestKey());
const classificationService=computed(()=>catalog.value.find(item=>item.code===classificationCode.value));
watch(classificationCode,()=>{classificationFields.value={};});
watch([classificationCode,classificationReason,classificationFields],()=>{classificationSafe.value=false;classificationKey.value=createRequestKey();},{deep:true});
const reviewPriority=ref<Priority>('P1'),reviewReason=ref(''),reviewSafe=ref(false),reviewKey=ref(createRequestKey());
const feedbackRating=ref(0),feedbackComment=ref(''),feedbackSafe=ref(false),feedbackKey=ref(createRequestKey());
watch([feedbackRating,feedbackComment],()=>{feedbackKey.value=createRequestKey();feedbackSafe.value=false;});
const reviewLabels:Record<string,string>={NOT_REQUIRED:'无需主管确认',PENDING:'候选 · 待主管确认',CONFIRMED:'主管已确认',ADJUSTED:'主管已调整'};
watch([reviewPriority,reviewReason],()=>{reviewKey.value=createRequestKey();reviewSafe.value=false;});
const fieldLabels:Record<string,string>={system:'业务系统',module:'模块 / 页面',location:'所在地点',device:'设备编号'};
const approvalLabels:Record<string,string>={QUEUED:'等待发起',CREATING:'正在发起',CREATE_UNCERTAIN:'发起结果待核实',PENDING:'审批中',APPROVED:'审批已通过',REJECTED:'审批未通过',WITHDRAWN:'已撤回',EXPIRED:'已过期',BLOCKED:'受阻待处理'};
const cancellationLabels={NOT_SENT:'申请已撤销，未发起钉钉审批。',OA_CONFIRMATION_REQUIRED:'申请已撤销，ITSM 不会交付。钉钉审批是否撤回，仍需在钉钉核对。',OA_CREATION_UNCERTAIN:'申请已撤销，ITSM 不会交付。钉钉审批是否发起，仍待核实。',OA_CLOSED:'申请已撤销，钉钉审批已结束。'};
const fulfillmentLabels:Record<string,string>={READY:'待人工交付',DELIVERED:'已交付',REVOKE_DUE:'待回收',REVOKED:'已回收',BLOCKED:'交付受阻'};
watch([comment,reason,dueAt,vendorReference,vendorOwner,category,evidence,target,targetPerson,continuationId,waitingReason],()=>{key.value=createRequestKey();contentSafe.value=false;});
watch(target,async value=>{
  targetPerson.value='';members.value=[];membersLoading.value=!!value;
  if(!value)return;
  try{const result=await api<{items:{id:string;name:string}[]}>(`/tickets/${props.id}/assignment-candidates?groupId=${encodeURIComponent(value)}`);if(target.value===value)members.value=result.items.filter(person=>person.id!==props.user.id&&person.id!==ticket.value?.assigneeId);}
  catch(e){if(target.value===value)error.value=errorText(e);}
  finally{if(target.value===value)membersLoading.value=false;}
});
const isAgent=computed(()=>ticket.value&&props.user.groups.includes(ticket.value.ownerGroupId));
const mine=computed(()=>ticket.value?.requesterId===props.user.id);
const completionReady=computed(()=>ticket.value?.serviceType!=='REQ'||ticket.value.requestCompletionReady===true);
const available=computed<TicketAction[]>(()=>{
  if(!ticket.value)return[];const state=ticket.value.status,result:TicketAction[]=[];
  if(mine.value){if(['NEW','QUEUED'].includes(state)||state==='WAITING_APPROVAL'&&ticket.value.serviceType==='REQ')result.push('CANCEL');if(state==='WAITING_USER')result.push('ADD_INFO');if(state==='PENDING_CONFIRMATION'){if(completionReady.value)result.push('CONFIRM');result.push('REOPEN');}}
  if(!mine.value&&ticket.value.canAddInfo&&state==='WAITING_USER')result.push('ADD_INFO');
  const active=['QUEUED','IN_PROGRESS','WAITING_USER','WAITING_VENDOR','PENDING_CONFIRMATION'].includes(state);
  if(active&&ticket.value.pendingAssigneeId===props.user.id)result.push(ticket.value.assignmentKind==='OFFER'?'ACCEPT_OFFER':'ACCEPT_HANDOVER',ticket.value.assignmentKind==='OFFER'?'DECLINE_OFFER':'DECLINE_HANDOVER');
  if(isAgent.value&&active){
    const owner=ticket.value.assigneeId===props.user.id;
    if(!ticket.value.assigneeId&&!ticket.value.pendingAssigneeId&&ticket.value.canClaim!==false)result.push('ACCEPT');
    if(owner&&ticket.value.canProcess){if(state==='IN_PROGRESS')result.push('REQUEST_INFO','WAIT_VENDOR');if(state==='WAITING_VENDOR')result.push('RESUME_VENDOR');if(['IN_PROGRESS','WAITING_VENDOR'].includes(state)&&completionReady.value)result.push('RESOLVE');}
    if(owner||(!ticket.value.assigneeId&&(state==='QUEUED'||ticket.value.serviceType==='REQ'&&state==='IN_PROGRESS')&&ticket.value.canDispatchQueued)){
      if(ticket.value.pendingAssigneeId)result.push(ticket.value.assignmentKind==='OFFER'?'CANCEL_OFFER':'CANCEL_HANDOVER');
      else {result.push('REASSIGN');if(ticket.value.canAssignOffer)result.push('ASSIGN_OFFER');}
    }
    const current=ticket.value.continuations?.filter(item=>item.current)??[];
    if(ticket.value.assigneeId&&(owner||ticket.value.canManageContinuity)&&!current.some(item=>item.status==='PENDING'||item.effective))result.push('CONTINUATION_PROPOSE');
    if(ticket.value.canManageContinuity){
      if(ticket.value.assigneeId&&!owner&&!ticket.value.pendingAssigneeId)result.push('INITIATE_HANDOVER');
      if(current.some(item=>item.status==='PENDING'&&item.proposedBy!==props.user.id&&item.employeeId!==props.user.id))result.push('CONTINUATION_APPROVE','CONTINUATION_REJECT');
      if(current.some(item=>item.effective))result.push('CONTINUATION_REVOKE');
    }
  }
  return result;
});
const commands=computed<Record<string,string>>(()=>({ACCEPT:'接单并回复',REQUEST_INFO:'请求补充',ADD_INFO:'补充信息',WAIT_VENDOR:'等待厂商',RESUME_VENDOR:'恢复处理',RESOLVE:'提交解决方案',CONFIRM:'确认已解决',REOPEN:'仍未解决',CANCEL:'撤销报障',REASSIGN:'发起交接',INITIATE_HANDOVER:'主管发起交接',CONTINUATION_PROPOSE:'申请限期处理',CONTINUATION_APPROVE:'批准限期处理',CONTINUATION_REJECT:'拒绝限期处理',CONTINUATION_REVOKE:'立即撤销授权',ACCEPT_HANDOVER:'确认接收',DECLINE_HANDOVER:'退回交接',CANCEL_HANDOVER:'撤回交接',ASSIGN_OFFER:'指定候选人',ACCEPT_OFFER:'确认接单并回复',DECLINE_OFFER:'拒绝接单',CANCEL_OFFER:'撤回派单',
  ...(ticket.value?.serviceType==='REQ'?{RESOLVE:'提交交付完成',CONFIRM:'确认已交付',REOPEN:'交付仍有问题',CANCEL:'撤销申请'}:{})}));
const resolutionCategories=computed(()=>ticket.value?.serviceType==='REQ'?['权限开通','资源交付','服务配置']:['配置调整','故障恢复','操作指导','厂商修复']);
const continuationLabels:Record<string,string>={PENDING:'待独立复核',APPROVED:'已批准',REJECTED:'已拒绝',REVOKED:'已撤销'};
const selectableContinuations=computed(()=>ticket.value?.continuations?.filter(item=>item.current&&
  (action.value==='CONTINUATION_REVOKE'?item.effective:item.status==='PENDING'&&item.proposedBy!==props.user.id&&item.employeeId!==props.user.id))??[]);
async function load(){loading.value=true;error.value='';try{ticket.value=await api<TicketView>(`/tickets/${props.id}`);catalog.value=(await api<{items:CatalogItem[]}>('/catalog')).items;if(props.user.groups.length)groups.value=(await api<{items:{id:string;name:string}[]}>('/support-groups')).items;}catch(e){error.value=errorText(e);}finally{loading.value=false;}}
function choose(value:TicketAction){correcting.value=false;action.value=value;comment.value='';reason.value='';dueAt.value='';waitingReason.value='';vendorReference.value='';vendorOwner.value='';category.value='';evidence.value='';target.value=value==='ASSIGN_OFFER'?ticket.value?.ownerGroupId??'':'';targetPerson.value='';continuationId.value=selectableContinuations.value[0]?.id??'';contentSafe.value=false;key.value=createRequestKey();error.value='';}
async function submitClassification(){
  if(!ticket.value||!classificationService.value||!classificationSafe.value||busy.value)return;busy.value=true;error.value='';
  try{await api(`/tickets/${props.id}/classification`,{method:'POST',key:classificationKey.value,body:{contentClass:'GENERAL',expectedVersion:ticket.value.version,serviceCode:classificationCode.value,formVersion:classificationService.value.formVersion,fields:classificationFields.value,reason:classificationReason.value}});
    correcting.value=false;classificationCode.value='';classificationReason.value='';await load();emit('changed');}
  catch(e){if(e instanceof ApiError&&e.status===409){await load();classificationKey.value=createRequestKey();}error.value=errorText(e);}finally{busy.value=false;}
}
async function submit(){
  if(!ticket.value||!action.value||busy.value||!contentSafe.value)return;busy.value=true;error.value='';
  const body:TicketActionInput={contentClass:'GENERAL',action:action.value,expectedVersion:ticket.value.version};
  if(comment.value)body.comment=comment.value;if(reason.value)body.reason=reason.value;
  if(dueAt.value)body.dueAt=new Date(dueAt.value).toISOString();
  if(waitingReason.value&&['REQUEST_INFO','WAIT_VENDOR'].includes(action.value))body.waitingReason=waitingReason.value;
  if(vendorReference.value)body.vendorReference=vendorReference.value;if(vendorOwner.value)body.vendorOwner=vendorOwner.value;
  if(category.value)body.resolutionCategory=category.value;if(evidence.value)body.evidence=evidence.value;if(target.value&&['REASSIGN','INITIATE_HANDOVER'].includes(action.value))body.targetGroupId=target.value;if(targetPerson.value)body.targetAssigneeId=targetPerson.value;
  if(continuationId.value&&action.value.startsWith('CONTINUATION_')&&action.value!=='CONTINUATION_PROPOSE')body.continuationId=continuationId.value;
  try{await api(`/tickets/${props.id}/actions`,{method:'POST',body,key:key.value});action.value=undefined;await load();emit('changed');}
  catch(e){if(e instanceof ApiError&&e.status===409){await load();if(action.value&&!available.value.includes(action.value))action.value=undefined;key.value=createRequestKey();}error.value=errorText(e);}finally{busy.value=false;}
}
async function submitPriorityReview(){
  if(!ticket.value||!ticket.value.canReviewPriority||!reviewSafe.value||!reviewReason.value.trim()||busy.value)return;
  busy.value=true;error.value='';
  try{await api(`/tickets/${props.id}/priority-review`,{method:'POST',key:reviewKey.value,body:{contentClass:'GENERAL',expectedVersion:ticket.value.version,priority:reviewPriority.value,reason:reviewReason.value}});
    reviewReason.value='';reviewSafe.value=false;reviewKey.value=createRequestKey();await load();emit('changed');}
  catch(e){if(e instanceof ApiError&&e.status===409){await load();reviewKey.value=createRequestKey();}error.value=errorText(e);}finally{busy.value=false;}
}
async function submitFeedback(){
  if(!ticket.value?.canFeedback||!feedbackSafe.value||!feedbackRating.value||busy.value)return;
  busy.value=true;error.value='';
  try{await api(`/tickets/${props.id}/feedback`,{method:'POST',key:feedbackKey.value,
    body:{contentClass:'GENERAL',rating:feedbackRating.value,...(feedbackComment.value.trim()?{comment:feedbackComment.value.trim()}:{})}});
    await load();emit('changed');}
  catch(e){error.value=errorText(e);if(e instanceof ApiError&&e.status===409)await load();}
  finally{busy.value=false;}
}
onMounted(load);
</script>
<template>
  <section class="detail-page"><button class="text-button" @click="emit('back')"><ArrowLeft :size="17"/> 返回工单列表</button><div v-if="loading&&!ticket" class="empty-state"><LoaderCircle class="spin"/> 正在加载</div><p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <template v-if="ticket"><div class="page-title"><div><p class="eyebrow">{{ticket.number}}</p><h1>{{ticket.subject}}</h1></div><button class="icon-button" title="刷新" aria-label="刷新工单" :disabled="loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button></div><div class="ticket-meta"><span class="status" :data-status="ticket.status">{{statuses[ticket.status]}}</span><span class="priority" :data-priority="ticket.priority">{{ticket.priority}}</span><span>{{formatDate(ticket.createdAt)}}</span><span>责任组：{{groups.find(g=>g.id===ticket?.ownerGroupId)?.name??ticket.ownerGroupId}}</span><span>处理人：{{ticket.assigneeName??ticket.assigneeId??'组内待认领'}}</span><span v-if="ticket.pendingAssigneeId" class="amber-text">{{ticket.assignmentKind==='OFFER'?'待候选确认':'待交接'}}：{{ticket.pendingAssigneeName??ticket.pendingAssigneeId}}<template v-if="ticket.assignmentDueAt"> · 截止 {{formatDate(ticket.assignmentDueAt)}}</template></span></div>
      <section v-if="isAgent&&(ticket.ownerContinuityRequired||ticket.continuations?.length)" class="detail-section" aria-label="责任连续性">
        <h2>责任连续性</h2><p v-if="ticket.ownerContinuityRequired" class="danger-text" role="status">当前负责人任职已失效，待交接或独立复核限期处理；负责人及 SLA 保持不变。</p>
        <ul class="timeline"><li v-for="item in ticket.continuations" :key="item.id"><strong>{{continuationLabels[item.status]??item.status}}</strong><span v-if="!item.current" class="muted"> · 历史责任</span><span v-else-if="item.status==='APPROVED'&&!item.effective" class="muted"> · 已失效</span><p>截止 {{formatDate(item.expiresAt)}} · {{item.employeeId}}</p><p class="multiline">{{item.reason}}</p></li></ul>
      </section>
      <PriorityPanel :key="`${ticket.id}:${ticket.version}`" :ticket="ticket" @changed="load();emit('changed')"/>
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
          <p v-if="ticket.priorityAlert.deliveries.REVIEW_REQUIRED" class="danger-text" role="status">{{ticket.priorityAlert.deliveries.REVIEW_REQUIRED}} 条 P1 通知发送结果待核查</p>
          <p v-if="ticket.priorityAlert.deliveries.PENDING||ticket.priorityAlert.deliveries.DISPATCHING||ticket.priorityAlert.deliveries.SENDING" class="muted">P1 通知发送中</p>
          <p v-if="ticket.priorityAlert.deliveries.DELIVERED" class="muted">平台已确认发送 {{ticket.priorityAlert.deliveries.DELIVERED}} 条 P1 通知</p>
        </template>
        <form v-if="ticket.canReviewPriority" class="action-form" @submit.prevent="submitPriorityReview">
          <label>确认优先级<select v-model="reviewPriority" required><option>P1</option><option>P2</option><option>P3</option><option>P4</option></select></label>
          <label>确认依据<textarea v-model="reviewReason" required maxlength="2000" rows="2"/></label>
          <ContentBoundary v-model="reviewSafe"/><div class="form-footer"><button type="submit" class="primary" :disabled="busy||!reviewSafe||!reviewReason.trim()"><Check :size="16"/>提交优先级确认</button></div>
        </form>
      </section>
      <section class="detail-section" aria-label="工单分类"><div class="section-heading"><div><h2>工单分类</h2><p>{{catalog.find(item=>item.code===ticket?.serviceCode)?.name??ticket.serviceCode}}</p><p v-if="ticket.originalServiceCode!==ticket.serviceCode" class="muted">原分类：{{catalog.find(item=>item.code===ticket?.originalServiceCode)?.name??ticket.originalServiceCode}}</p></div><button v-if="ticket.canCorrectClassification" class="secondary" :disabled="busy" @click="correcting=!correcting;action=undefined"><Tags :size="16"/>分类纠偏</button></div>
        <form v-if="correcting&&ticket.canCorrectClassification" class="action-form" @submit.prevent="submitClassification">
          <label>调整为<select v-model="classificationCode" required><option value="">请选择</option><option v-for="item in catalog.filter(item=>item.available&&item.code!==ticket?.serviceCode)" :key="item.code" :value="item.code">{{item.name}}</option></select></label>
          <label v-for="field in classificationService?.fields??[]" :key="field.key">{{field.label}}<select v-if="field.options" v-model="classificationFields[field.key]" :required="field.required"><option value="">请选择</option><option v-for="option in field.options" :key="option">{{option}}</option></select><input v-else v-model="classificationFields[field.key]" :required="field.required" maxlength="500"/></label>
          <label>纠偏原因<textarea v-model="classificationReason" required maxlength="2000" rows="2"/></label><ContentBoundary v-model="classificationSafe"/><div class="form-footer"><button class="primary" type="submit" :disabled="busy||!classificationSafe||!classificationCode||!classificationReason.trim()"><Check :size="16"/>保存分类</button></div>
        </form>
      </section>
      <section v-if="mine&&ticket.serviceType==='REQ'" class="detail-section" aria-label="申请进度"><h2>申请进度</h2>
        <p v-if="ticket.requestProgress?.cancellation" role="status">{{cancellationLabels[ticket.requestProgress.cancellation]}}</p>
        <template v-else><template v-if="ticket.requestProgress?.approval"><p>审批：<strong>{{approvalLabels[ticket.requestProgress.approval.state]??ticket.requestProgress.approval.state}}</strong><span class="muted"> · {{formatDate(ticket.requestProgress.approval.updatedAt)}}</span></p></template>
        <p v-else class="muted">审批记录尚未生成。</p>
        <template v-if="ticket.requestProgress?.fulfillment"><p>交付：<strong>{{fulfillmentLabels[ticket.requestProgress.fulfillment.state]??ticket.requestProgress.fulfillment.state}}</strong><span class="muted"> · {{formatDate(ticket.requestProgress.fulfillment.updatedAt)}}</span></p>
          <p v-if="ticket.requestProgress.fulfillment.deliveredAt" class="muted">交付时间：{{formatDate(ticket.requestProgress.fulfillment.deliveredAt)}}</p>
          <p v-if="ticket.requestProgress.fulfillment.accessExpiresAt" class="muted">权限到期：{{formatDate(ticket.requestProgress.fulfillment.accessExpiresAt)}}</p>
          <p v-if="ticket.requestProgress.fulfillment.revokedAt" class="muted">回收时间：{{formatDate(ticket.requestProgress.fulfillment.revokedAt)}}</p>
          <p v-if="ticket.requestProgress.fulfillment.reviewedAt" class="muted">交付复核：{{formatDate(ticket.requestProgress.fulfillment.reviewedAt)}}</p>
        </template><p v-else class="muted">交付记录尚未生成；审批通过不代表权限已开通。</p></template>
      </section>
      <p v-if="ticket.serviceType==='REQ'&&['IN_PROGRESS','WAITING_VENDOR','PENDING_CONFIRMATION'].includes(ticket.status)" class="muted" role="status">{{completionReady?'交付与独立复核记录齐备':'交付完成条件未齐备，待核验审批、实际交付及独立复核记录。'}}</p>
      <section v-if="ticket.waiting" class="detail-section" aria-label="等待跟进"><h2>等待跟进</h2><p>{{waitingReasons[ticket.waiting.reason]}}</p><p v-if="ticket.waiting.since">开始时间：{{formatDate(ticket.waiting.since,true)}}</p><p v-if="ticket.waiting.dueAt" :class="{'danger-text':ticket.waiting.followUpOverdue}">跟进期限：{{formatDate(ticket.waiting.dueAt,true)}}<strong v-if="ticket.waiting.followUpOverdue"> · 已到期</strong></p><p v-else class="muted">历史跟进期限未记录</p></section>
      <div class="detail-grid"><div><section class="detail-section"><h2>{{ticket.serviceType==='REQ'?'申请详情':'报障详情'}}</h2><p class="multiline">{{ticket.description}}</p><dl v-if="Object.keys(ticket.fields).length" class="fact-list"><template v-for="(value,name) in ticket.fields" :key="name"><dt>{{fieldLabels[String(name)]??name}}</dt><dd>{{value}}</dd></template></dl></section>
        <TicketAttachments :key="ticket.id" :ticket-id="ticket.id" :version="ticket.version"/>
        <section class="detail-section"><div class="section-heading"><h2>处理记录</h2><span class="muted">{{ticket.events?.length??0}} 条</span></div><ol class="timeline"><li v-for="(event,index) in ticket.events??[]" :key="index"><span class="timeline-dot"></span><div class="event-title"><strong>{{actions[event.action]??event.action}}</strong><time>{{formatDate(event.createdAt)}}</time></div><p v-if="event.actorId" class="muted">{{event.actorName??event.actorId}}</p><p v-if="event.detail.oldPriority" class="muted">{{event.detail.oldPriority}} → {{event.detail.priority}}</p><p v-if="event.detail.comment" class="multiline">{{event.detail.comment}}</p><p v-if="event.detail.reason" class="multiline">{{event.detail.reason}}</p><p v-if="event.detail.vendorReference" class="muted">厂商单号：{{event.detail.vendorReference}}</p><p v-if="event.detail.targetGroupId" class="muted">{{event.detail.oldGroupId}} → {{event.detail.targetGroupId}}</p></li></ol></section>
      </div><aside><section v-if="ticket.canFeedback||ticket.feedback" class="detail-section" aria-label="服务评价"><h2>服务评价</h2>
          <template v-if="ticket.feedback"><p>{{ticket.feedback.rating}} / 5 · {{formatDate(ticket.feedback.createdAt)}}</p><p v-if="ticket.feedback.comment" class="multiline">{{ticket.feedback.comment}}</p></template>
          <form v-else class="action-form" @submit.prevent="submitFeedback">
            <label>满意度<select v-model.number="feedbackRating" required><option :value="0" disabled>请选择</option><option v-for="value in 5" :key="value" :value="value">{{value}} 分</option></select></label>
            <label>补充意见（选填）<textarea v-model="feedbackComment" maxlength="1000" rows="3"/></label>
            <ContentBoundary v-model="feedbackSafe"/><div class="form-footer"><button type="submit" class="primary" :disabled="busy||!feedbackSafe||!feedbackRating"><Check :size="16"/>提交评价</button></div>
          </form></section>
        <section class="detail-section sla-section"><h2><Clock3 :size="17"/> 服务时效</h2><div v-for="sla in ticket.sla??[]" :key="sla.cycle" class="sla-cycle"><div class="section-heading"><strong>第 {{sla.cycle}} 轮 · 原始 {{sla.priority}}</strong><span :class="sla.breached?'danger-text':'muted'">{{sla.breached?'已超时':sla.completed?'已停止':sla.paused?(sla.pauseReason==='APPROVAL'?'等待审批，交付计时暂停':'等待补充，解决计时暂停'):'计时中'}}</span></div><p>首次响应 <strong>{{duration(sla.responseMinutes)}}</strong> / {{duration(sla.responseTarget)}}</p><p>{{ticket.serviceType==='REQ'?'交付耗时':'解决耗时'}} <strong>{{duration(sla.resolutionMinutes)}}</strong> / {{duration(sla.resolutionTarget)}}</p><div v-for="o in sla.obligations??[]" :key="o.id"><strong :class="{'danger-text':o.breached}">升级 {{o.priority}} · {{o.breached?'已超时':'时限保留'}}</strong><p>响应 {{duration(o.responseMinutes)}} / {{duration(o.responseTarget)}}</p><p>解决 / 交付 {{duration(o.resolutionMinutes)}} / {{duration(o.resolutionTarget)}}</p></div><p v-if="!sla.responded&&!sla.completed" class="muted">等待人工回复送达</p></div><p v-if="!ticket.sla?.length" class="muted">此工单暂无 SLA 周期。</p><p class="caption">当前使用试点服务日历</p></section>
        <section v-if="available.length" class="detail-section"><h2>处理操作</h2><div class="action-list"><button v-for="value in available" :key="value" class="secondary" :class="{selected:action===value}" @click="choose(value)">{{commands[value]}}</button></div>
          <form v-if="action" class="action-form" @submit.prevent="submit">
            <p v-if="action==='CANCEL'&&ticket.serviceType==='REQ'">撤销后将停止交付。已发起的钉钉审批不会自动撤回。</p>
            <label v-if="['ACCEPT','ACCEPT_HANDOVER','ACCEPT_OFFER','REQUEST_INFO','ADD_INFO','WAIT_VENDOR','RESUME_VENDOR','RESOLVE'].includes(action)">{{action==='RESOLVE'?(ticket.serviceType==='REQ'?'交付说明':'解决说明'):action==='REQUEST_INFO'?'需要补充的内容':action==='RESUME_VENDOR'?'继续处理说明':'回复内容'}}<textarea v-model="comment" required maxlength="2000" rows="3"/></label>
            <label v-if="action.startsWith('CONTINUATION_')||['REOPEN','REASSIGN','INITIATE_HANDOVER','ASSIGN_OFFER','DECLINE_HANDOVER','CANCEL_HANDOVER','DECLINE_OFFER','CANCEL_OFFER'].includes(action)">原因<textarea v-model="reason" required maxlength="2000" rows="3"/></label>
            <label v-if="action.startsWith('CONTINUATION_')&&action!=='CONTINUATION_PROPOSE'">授权记录<select v-model="continuationId" required><option value="">请选择</option><option v-for="item in selectableContinuations" :key="item.id" :value="item.id">{{formatDate(item.expiresAt)}} · {{item.employeeId}}</option></select></label>
            <label v-if="action==='CONTINUATION_PROPOSE'">处理授权截止时间<input v-model="dueAt" required type="datetime-local"/></label>
            <template v-if="['REASSIGN','INITIATE_HANDOVER','ASSIGN_OFFER'].includes(action)">
              <label v-if="action!=='ASSIGN_OFFER'">目标支持组<select v-model="target" required><option value="">请选择</option><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
              <label>接收人<select v-model="targetPerson" required :disabled="!target||membersLoading"><option value="">{{membersLoading?'正在加载':members.length?'请选择':'暂无可选人员'}}</option><option v-for="person in members" :key="person.id" :value="person.id">{{person.name}}</option></select></label>
            </template>
            <template v-if="['REQUEST_INFO','WAIT_VENDOR'].includes(action)"><label>等待原因<select v-model="waitingReason" required><option value="">请选择</option><option v-for="code in waitingOptions" :key="code" :value="code">{{waitingReasons[code]}}</option></select></label><label>{{action==='REQUEST_INFO'?'补充截止时间':'下次跟进时间'}}<input v-model="dueAt" required type="datetime-local"/></label></template>
            <template v-if="action==='WAIT_VENDOR'"><label>厂商工单号<input v-model="vendorReference" required maxlength="200"/></label><label>跟进负责人<input v-model="vendorOwner" required maxlength="200"/></label></template>
            <template v-if="action==='RESOLVE'"><label>{{ticket.serviceType==='REQ'?'交付分类':'解决分类'}}<select v-model="category" required><option value="">请选择</option><option v-for="item in resolutionCategories" :key="item">{{item}}</option></select></label><label>验证依据<textarea v-model="evidence" required maxlength="2000" rows="2"/></label></template>
            <ContentBoundary v-model="contentSafe"/><div class="form-footer"><button type="button" class="text-button" :disabled="busy" @click="action=undefined">取消</button><button type="submit" class="primary" :disabled="busy||membersLoading||(['REASSIGN','INITIATE_HANDOVER','ASSIGN_OFFER'].includes(action)&&!targetPerson)"><LoaderCircle v-if="busy" :size="16" class="spin"/><Check v-else :size="16"/>{{commands[action]}}</button></div>
          </form></section>
      </aside></div>
    </template>
  </section>
</template>
