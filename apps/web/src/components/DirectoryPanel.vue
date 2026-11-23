<script setup lang="ts">
import { onBeforeUnmount,onMounted,ref } from 'vue';
import { RefreshCw,Users } from 'lucide-vue-next';
import { api,errorText } from '../api';
import { formatDate } from '../labels';
type Run={id:string;state:string;peopleCount:number;createdCount:number;updatedCount:number;disabledCount:number;missingCount:number;errorCode:string|null;startedAt:string;completedAt:string|null};
type Status={enabled:boolean;configured:boolean;retireMissing:boolean;scopeMode:'pilot'|'authorized';lastSuccessAt:string|null;stale:boolean;counts:{people:number;active:number;missing:number;disabled:number};runs:Run[]};
const status=ref<Status>(),loading=ref(false),error=ref('');
const states:Record<string,string>={RUNNING:'同步中',SUCCEEDED:'成功',FAILED:'失败'};
const failures:Record<string,string>={DIRECTORY_PROVIDER_INVALID:'钉钉返回数据不完整',DIRECTORY_PROVIDER_UNAVAILABLE:'钉钉接口不可用',DIRECTORY_TOKEN_UNAVAILABLE:'应用凭据不可用',DIRECTORY_EMPTY_SNAPSHOT:'通讯录为空，已停止更新',DIRECTORY_SCOPE_TOO_LARGE:'可见范围超过同步上限',DIRECTORY_SNAPSHOT_CHANGED:'同步期间资料变化，等待下次重试',DIRECTORY_IDENTITY_CONFLICT:'人员身份映射冲突',DIRECTORY_REMOVAL_LIMIT:'待停用比例超过限制',DIRECTORY_INTERRUPTED:'同步被中断',DIRECTORY_SYNC_FAILED:'同步失败，等待重试'};
let timer:ReturnType<typeof setInterval>|undefined;
let disposed=false;
async function load(){
  if(loading.value)return;loading.value=true;error.value='';
  try{const value=await api<Status>('/admin/directory/status');if(!disposed)status.value=value;}
  catch(e){if(!disposed){status.value=undefined;error.value=errorText(e);}}
  finally{if(!disposed)loading.value=false;}
}
onMounted(()=>{void load();timer=setInterval(()=>{if(!document.hidden)void load();},30000);});
onBeforeUnmount(()=>{disposed=true;if(timer)clearInterval(timer);});
</script>
<template>
  <section aria-label="钉钉人员同步">
    <div class="section-heading"><span v-if="status" class="count-badge">{{!status.enabled?'同步未启用':!status.configured?'配置待补齐':status.stale?'同步待核查':'同步正常'}}</span><button class="icon-button" title="刷新同步状态" aria-label="刷新同步状态" :disabled="loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <template v-if="status">
      <section class="summary-strip" aria-label="人员同步概况"><div><span>已关联人员</span><strong>{{status.counts.people}}</strong></div><div><span>有效人员</span><strong>{{status.counts.active}}</strong></div><div><span>待核查缺失</span><strong>{{status.counts.missing}}</strong></div><div><span>同步已停用</span><strong>{{status.counts.disabled}}</strong></div></section>
      <dl class="sync-facts"><div><dt>通讯录范围</dt><dd>{{status.scopeMode==='authorized'?'已授权部门及子部门':'试点人员范围'}}</dd></div><div><dt>最近成功</dt><dd>{{status.lastSuccessAt?formatDate(status.lastSuccessAt):'尚无记录'}}</dd></div><div><dt>缺失人员自动停用</dt><dd>{{status.retireMissing?'已启用':'未启用'}}</dd></div></dl>
      <div class="table-wrap"><table><thead><tr><th>开始时间</th><th>结果</th><th>读取人数</th><th>新增</th><th>更新</th><th>缺失</th><th>停用</th><th>异常原因</th></tr></thead><tbody><tr v-for="run in status.runs" :key="run.id"><td>{{formatDate(run.startedAt)}}</td><td>{{states[run.state]??'待核查'}}</td><td>{{run.peopleCount}}</td><td>{{run.createdCount}}</td><td>{{run.updatedCount}}</td><td>{{run.missingCount}}</td><td>{{run.disabledCount}}</td><td>{{run.errorCode?(failures[run.errorCode]??'同步异常'):'—'}}</td></tr></tbody></table><div v-if="!status.runs.length" class="empty-state"><Users :size="28"/><p>暂无同步记录</p></div></div>
    </template>
  </section>
</template>
<style scoped>
.sync-facts{display:flex;flex-wrap:wrap;gap:16px 32px;margin:18px 0;font-size:13px}.sync-facts>div{display:flex;flex-wrap:wrap;gap:8px}.sync-facts dt{color:#61727b}.sync-facts dd{margin:0;overflow-wrap:anywhere}
</style>
