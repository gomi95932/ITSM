<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref } from 'vue';
import { Download,RefreshCw,Users } from 'lucide-vue-next';
import { api,errorText } from '../api';
import { formatDate } from '../labels';
import { createRequestKey } from '../request-key';
type Run={id:string;state:string;triggerSource:string;peopleCount:number;createdCount:number;updatedCount:number;disabledCount:number;missingCount:number;errorCode:string|null;errorDetails:{stage:string;vendorCode?:number;vendorSubcode?:string}|null;startedAt:string;completedAt:string|null};
type Status={enabled:boolean;configured:boolean;retireMissing:boolean;scopeMode:'pilot'|'authorized';lastSuccessAt:string|null;nextAutomaticAt:string|null;automaticIntervalHours:number;activeRun:{id:string;state:string}|null;stale:boolean;counts:{people:number;active:number;missing:number;disabled:number};runs:Run[]};
const status=ref<Status>(),loading=ref(false),submitting=ref(false),error=ref(''),notice=ref('');
let requestKey:string|undefined;
const states:Record<string,string>={QUEUED:'等待同步',RUNNING:'同步中',SUCCEEDED:'成功',FAILED:'失败'};
const sources:Record<string,string>={AUTOMATIC:'每日自动',MANUAL:'管理员手工',MAINTENANCE:'维护操作'};
const badge=computed(()=>!status.value?.enabled?'同步未启用':!status.value.configured?'配置待补齐':status.value.activeRun?states[status.value.activeRun.state]:status.value.runs[0]?.state==='FAILED'?'最近同步失败':status.value.stale?'同步待核查':'同步正常');
const failures:Record<string,string>={DIRECTORY_PROVIDER_INVALID:'钉钉接口拒绝请求或数据格式异常',DIRECTORY_PROVIDER_UNAVAILABLE:'钉钉接口不可用',DIRECTORY_PROVIDER_TRANSIENT:'钉钉接口暂时繁忙',DIRECTORY_TOKEN_UNAVAILABLE:'应用凭据不可用',DIRECTORY_EMPTY_SNAPSHOT:'通讯录为空，已停止更新',DIRECTORY_SCOPE_TOO_LARGE:'可见范围超过同步上限',DIRECTORY_SNAPSHOT_CHANGED:'同步期间资料变化，请重试',DIRECTORY_IDENTITY_CONFLICT:'人员身份映射冲突',DIRECTORY_REMOVAL_LIMIT:'待停用比例超过限制',DIRECTORY_INTERRUPTED:'同步被中断',DIRECTORY_SYNC_FAILED:'同步失败，请核查后重试'};
let timer:ReturnType<typeof setInterval>|undefined;
let disposed=false;
async function load(){
  if(loading.value)return;loading.value=true;error.value='';
  try{const value=await api<Status>('/admin/directory/status');if(!disposed)status.value=value;}
  catch(e){if(!disposed){status.value=undefined;error.value=errorText(e);}}
  finally{if(!disposed)loading.value=false;}
}
async function synchronize(){
  if(submitting.value||!status.value?.enabled||!status.value.configured||status.value.activeRun)return;
  submitting.value=true;error.value='';notice.value='';
  try{
    requestKey??=createRequestKey();
    const result=await api<{id:string;state:string;reused:boolean}>('/admin/directory/sync',{method:'POST',key:requestKey});
    requestKey=undefined;
    if(!disposed){notice.value=result.state==='SUCCEEDED'?'本次同步已完成。':result.state==='FAILED'?'本次同步失败，请查看异常原因。':'同步任务已提交。';await load();}
  }catch(e){if(!disposed){error.value=errorText(e);await load();error.value=errorText(e);}}
  finally{if(!disposed)submitting.value=false;}
}
onMounted(()=>{void load();timer=setInterval(()=>{if(!document.hidden)void load();},30000);});
onBeforeUnmount(()=>{disposed=true;if(timer)clearInterval(timer);});
</script>
<template>
  <section aria-label="钉钉人员同步">
    <div class="section-heading"><span v-if="status" class="count-badge">{{badge}}</span><div class="sync-actions"><button class="primary" :disabled="submitting||loading||!status?.enabled||!status.configured||!!status.activeRun" @click="synchronize"><Download :size="17"/>{{submitting?'正在提交':status?.activeRun?states[status.activeRun.state]:'立即同步'}}</button><button class="icon-button" title="刷新同步状态" aria-label="刷新同步状态" :disabled="loading" @click="load"><RefreshCw :size="18" :class="{spin:loading}"/></button></div></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <p v-if="notice" role="status">{{notice}}</p>
    <template v-if="status">
      <section class="summary-strip" aria-label="人员同步概况"><div><span>已关联人员</span><strong>{{status.counts.people}}</strong></div><div><span>有效人员</span><strong>{{status.counts.active}}</strong></div><div><span>待核查缺失</span><strong>{{status.counts.missing}}</strong></div><div><span>同步已停用</span><strong>{{status.counts.disabled}}</strong></div></section>
      <dl class="sync-facts"><div><dt>自动同步</dt><dd>每天一次</dd></div><div><dt>下次自动同步</dt><dd>{{!status.enabled?'未启用':status.nextAutomaticAt?formatDate(status.nextAutomaticAt):'等待首次调度'}}</dd></div><div><dt>通讯录范围</dt><dd>{{status.scopeMode==='authorized'?'已授权部门及子部门':'试点人员范围'}}</dd></div><div><dt>最近成功</dt><dd>{{status.lastSuccessAt?formatDate(status.lastSuccessAt):'尚无记录'}}</dd></div><div><dt>缺失人员自动停用</dt><dd>{{status.retireMissing?'已启用':'未启用'}}</dd></div></dl>
      <div class="table-wrap"><table><thead><tr><th>开始时间</th><th>来源</th><th>结果</th><th>读取人数</th><th>新增</th><th>更新</th><th>缺失</th><th>停用</th><th>异常原因</th></tr></thead><tbody><tr v-for="run in status.runs" :key="run.id"><td>{{formatDate(run.startedAt)}}</td><td>{{sources[run.triggerSource]??'历史记录'}}</td><td>{{states[run.state]??'待核查'}}</td><td>{{run.peopleCount}}</td><td>{{run.createdCount}}</td><td>{{run.updatedCount}}</td><td>{{run.missingCount}}</td><td>{{run.disabledCount}}</td><td>{{run.errorCode?(failures[run.errorCode]??'同步异常'):'—'}}<small v-if="run.errorDetails">{{run.errorDetails.stage}}<template v-if="run.errorDetails.vendorCode!==undefined"> / {{run.errorDetails.vendorCode}}</template><template v-if="run.errorDetails.vendorSubcode"> / {{run.errorDetails.vendorSubcode}}</template></small></td></tr></tbody></table><div v-if="!status.runs.length" class="empty-state"><Users :size="28"/><p>暂无同步记录</p></div></div>
    </template>
  </section>
</template>
<style scoped>
.sync-facts{display:flex;flex-wrap:wrap;gap:16px 32px;margin:18px 0;font-size:13px}.sync-facts>div{display:flex;flex-wrap:wrap;gap:8px}.sync-facts dt{color:#61727b}.sync-facts dd{margin:0;overflow-wrap:anywhere}
.sync-actions{display:flex;align-items:center;gap:8px}td small{display:block}
</style>
