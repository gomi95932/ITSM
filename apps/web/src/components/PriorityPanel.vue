<script setup lang="ts">
import {ref,watch} from 'vue';
import {Check,LoaderCircle} from 'lucide-vue-next';
import {PRIORITIES,PRIORITY_LABELS,type TicketView,type Priority,type Impact,type Urgency} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import ContentBoundary from './ContentBoundary.vue';
const props=defineProps<{ticket:TicketView}>();
const emit=defineEmits<{changed:[]}>();
const priority=ref<Priority>(props.ticket.priority),impact=ref<Impact>(props.ticket.impact),urgency=ref<Urgency>(props.ticket.urgency);
const reason=ref(''),mode=ref<'APPLY'|'SUGGEST'>('SUGGEST'),safe=ref(false),busy=ref(false),error=ref(''),key=ref(createRequestKey());
watch([priority,impact,urgency,reason,mode],()=>{key.value=createRequestKey();safe.value=false;});
async function submit(){
  if(busy.value||!safe.value||!reason.value.trim())return;busy.value=true;error.value='';
  try{await api(`/tickets/${props.ticket.id}/priority`,{method:'POST',key:key.value,body:{contentClass:'GENERAL',expectedVersion:props.ticket.version,
    priority:priority.value,impact:impact.value,urgency:urgency.value,reason:reason.value,mode:mode.value}});
    reason.value='';safe.value=false;emit('changed');}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
</script>
<template>
  <section class="detail-section" aria-label="工单分级">
    <div class="section-heading"><h2>工单分级</h2><strong>{{ticket.priority}} · {{PRIORITY_LABELS[ticket.priority]}}</strong></div>
    <p class="muted">初始 {{ticket.initialPriority??ticket.priority}} · 规则版本 {{ticket.priorityPolicyVersion??1}}</p>
    <form v-if="ticket.canChangePriority||ticket.canSuggestPriority" @submit.prevent="submit" class="action-form">
      <label>处理方式<select v-model="mode" aria-label="分级处理方式"><option value="SUGGEST">提交调级建议</option><option v-if="ticket.priorityReviewState!=='PENDING'" value="APPLY">调整优先级</option></select></label>
      <label>目标优先级<select v-model="priority" aria-label="目标优先级"><option v-for="p in PRIORITIES" :key="p" :value="p">{{p}} · {{PRIORITY_LABELS[p]}}</option></select></label>
      <label>核实影响范围<select v-model="impact"><option value="COMPANY">全公司 / 核心生产</option><option value="DEPARTMENT">部门 / 多人</option><option value="INDIVIDUAL">仅一人</option></select></label>
      <label>核实紧急程度<select v-model="urgency"><option value="HIGH">工作中断，暂无替代方式</option><option value="MEDIUM">工作明显受影响</option><option value="LOW">可继续工作 / 可计划</option></select></label>
      <label>分级依据<textarea v-model="reason" required maxlength="2000" rows="3"/></label>
      <p v-if="ticket.priority==='P1'" class="muted">P1 降级需独立主管复核。</p>
      <p v-else-if="!ticket.canChangePriority" class="muted">当前负责人可直接升级；降级提交服务台复核。</p>
      <ContentBoundary v-model="safe"/><p v-if="error" role="alert" class="error-banner">{{error}}</p>
      <button type="submit" class="primary" :disabled="busy||!safe||!reason.trim()"><LoaderCircle v-if="busy" :size="16" class="spin"/><Check v-else :size="16"/>{{mode==='SUGGEST'?'提交建议':'确认调级'}}</button>
    </form>
  </section>
</template>
