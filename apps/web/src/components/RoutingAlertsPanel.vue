<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref } from 'vue';
import { RefreshCw,TriangleAlert } from 'lucide-vue-next';
import { api,errorText } from '../api';
import { formatDate } from '../labels';

type Alert = { ticketId:string; number:string; ownerGroupId:string; ownerGroupName:string; reason:string; openedAt:string };
const alerts=ref<Alert[]>([]),loading=ref(false),error=ref('');
let timer:ReturnType<typeof setInterval>|undefined;
async function load(){
  if(loading.value)return;
  loading.value=true;error.value='';
  try{alerts.value=(await api<{items:Alert[]}>('/routing-alerts')).items;}
  catch(e){error.value=errorText(e);}
  finally{loading.value=false;}
}
onMounted(()=>{void load();timer=setInterval(()=>{if(!document.hidden)void load();},30000);});
onBeforeUnmount(()=>{if(timer)clearInterval(timer);});
</script>

<template>
  <section aria-label="待处理路由告警">
    <div class="section-heading">
      <span class="count-badge danger">{{alerts.length}} 条待处理</span>
      <button class="icon-button" title="刷新告警" aria-label="刷新告警" :disabled="loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button>
    </div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div class="table-wrap">
      <table><thead><tr><th>工单</th><th>支持组</th><th>原因</th><th>发生时间</th></tr></thead>
        <tbody><tr v-for="alert in alerts" :key="alert.ticketId">
          <td>{{alert.number}}</td><td>{{alert.ownerGroupName}}</td><td><span class="status failed">{{alert.reason==='OWNER_APPOINTMENT_REQUIRED'?'当前负责人任职失效':alert.reason==='NO_POSITION_COVERAGE'?'无有效岗位任职人员':'无可用备用组'}}</span></td><td>{{formatDate(alert.openedAt)}}</td>
        </tr></tbody>
      </table>
      <div v-if="!alerts.length && !loading" class="empty-state"><TriangleAlert :size="28"/><p>暂无待处理路由告警</p></div>
    </div>
  </section>
</template>
