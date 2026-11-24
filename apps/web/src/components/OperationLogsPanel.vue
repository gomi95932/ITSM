<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';
import {ChevronLeft,ChevronRight,LoaderCircle,RefreshCw,RotateCcw,Search,ScrollText,X} from 'lucide-vue-next';
import {OPERATION_LOG_MODULES,OPERATION_LOG_RESULTS,type OperationLogDetail,type OperationLogFilter,type OperationLogList} from '@itsm/contracts';
import {api,errorText} from '../api';
import {formatDate} from '../labels';
import {operationAction} from '../operation-logs';
const props=defineProps<{initial:OperationLogFilter}>();
const query=ref(''),actor=ref(''),module=ref(''),result=ref(''),object=ref(''),from=ref(''),to=ref('');
const page=ref(1),data=ref<OperationLogList>(),loading=ref(false),error=ref('');
const detail=ref<OperationLogDetail>(),detailLoading=ref(false),detailError=ref(''),detailOpen=ref(false),closeButton=ref<HTMLButtonElement>();
const applied=ref<Record<string,string>>({});let generation=0,detailGeneration=0,returnFocus:HTMLElement|null=null;
const pages=computed(()=>Math.max(1,Math.ceil((data.value?.total??0)/20)));
const text=(value:unknown)=>value===null||value===undefined?'无 / 未记录':typeof value==='object'?JSON.stringify(value,null,2):String(value);
const actorLabel=(row:{actorId:string|null;actorName:string|null})=>row.actorName??(row.actorId?.startsWith('system:')?'系统任务':row.actorId??'系统任务 / 历史未记录');
async function load(){
  const current=++generation;loading.value=true;error.value='';data.value=undefined;
  try{const params=new URLSearchParams({...applied.value,page:String(page.value),size:'20'});
    const value=await api<OperationLogList>(`/admin/operation-logs?${params}`);if(current===generation)data.value=value;
  }catch(e){if(current===generation)error.value=errorText(e);}finally{if(current===generation)loading.value=false;}
}
function search(){
  if(from.value&&to.value&&from.value>to.value){error.value='结束时间不能早于开始时间';return;}
  const values:Record<string,string>={q:query.value.trim(),actor:actor.value.trim(),module:module.value,result:result.value,object:object.value.trim()};
  if(from.value)values.from=new Date(from.value).toISOString();if(to.value)values.to=new Date(to.value).toISOString();
  applied.value=Object.fromEntries(Object.entries(values).filter(([,value])=>value));page.value=1;void load();
}
function reset(){query.value='';actor.value='';module.value='';result.value='';object.value='';from.value='';to.value='';search();}
function turn(value:number){page.value=value;void load();}
function close(){++detailGeneration;detailOpen.value=false;detail.value=undefined;detailError.value='';void nextTick(()=>returnFocus?.focus());}
async function inspect(id:string){
  returnFocus=document.activeElement as HTMLElement;detailOpen.value=true;detail.value=undefined;detailError.value='';detailLoading.value=true;
  const current=++detailGeneration;await nextTick();closeButton.value?.focus();
  try{const value=await api<OperationLogDetail>(`/admin/operation-logs/${encodeURIComponent(id)}`);if(current===detailGeneration)detail.value=value;}
  catch(e){if(current===detailGeneration)detailError.value=errorText(e);}finally{if(current===detailGeneration)detailLoading.value=false;}
}
function trap(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();close();}else if(event.key==='Tab'){event.preventDefault();closeButton.value?.focus();}}
watch(()=>props.initial,value=>{query.value=value.q??'';actor.value=value.actor??'';module.value=value.module??'';result.value=value.result??'';object.value=value.object??'';from.value='';to.value='';search();},{immediate:true});
onBeforeUnmount(()=>{++generation;++detailGeneration;});
</script>
<template>
  <section class="operation-logs" aria-label="操作日志">
    <form class="log-filters" @submit.prevent="search">
      <label class="log-query">关键词<input v-model="query" maxlength="200" placeholder="工单号、操作对象、动作或变更依据"/></label>
      <label>操作人<input v-model="actor" maxlength="200" placeholder="姓名或人员 ID"/></label>
      <label>模块<select v-model="module"><option value="">全部模块</option><option v-for="(label,key) in OPERATION_LOG_MODULES" :key="key" :value="key">{{label}}</option></select></label>
      <label>结果<select v-model="result"><option value="">全部结果</option><option v-for="(label,key) in OPERATION_LOG_RESULTS" :key="key" :value="key">{{label}}</option></select></label>
      <label>开始时间<input v-model="from" type="datetime-local"/></label><label>结束时间<input v-model="to" type="datetime-local"/></label>
      <label>操作对象 ID<input v-model="object" maxlength="200" placeholder="精确对象 ID"/></label>
      <div class="log-actions"><button class="primary" :disabled="loading"><Search :size="16"/>查询</button><button type="button" class="icon-button" title="清空筛选" aria-label="清空筛选" :disabled="loading" @click="reset"><RotateCcw :size="17"/></button><button type="button" class="icon-button" title="刷新操作日志" aria-label="刷新操作日志" :disabled="loading" @click="load"><RefreshCw :size="17"/></button></div>
    </form>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div v-if="loading" class="empty-state" role="status"><LoaderCircle class="spin" :size="24"/>正在查询</div>
    <div v-else-if="data?.items.length" class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>模块 / 对象</th><th>操作</th><th>结果</th><th>依据</th><th></th></tr></thead><tbody><tr v-for="item in data.items" :key="item.id">
      <td>{{formatDate(item.createdAt,true)}}</td><td>{{actorLabel(item)}}</td><td><strong>{{OPERATION_LOG_MODULES[item.module]}}</strong><small>{{item.objectName}}</small></td><td>{{operationAction(item.action)}}</td><td><span class="status">{{OPERATION_LOG_RESULTS[item.result]}}</span></td><td class="log-reason">{{item.reason??'历史未记录'}}</td><td><button class="icon-button" :aria-label="`查看日志 ${item.id}`" title="查看日志详情" @click="inspect(item.id)"><ChevronRight :size="18"/></button></td>
    </tr></tbody></table></div>
    <div v-else-if="!error" class="empty-state"><ScrollText :size="28"/><p>没有符合条件的操作日志</p></div>
    <footer v-if="data" class="pagination"><span>共 {{data.total}} 条</span><div><button class="icon-button" title="上一页" aria-label="日志上一页" :disabled="loading||page<=1" @click="turn(page-1)"><ChevronLeft :size="18"/></button><span>{{page}} / {{pages}}</span><button class="icon-button" title="下一页" aria-label="日志下一页" :disabled="loading||page>=pages" @click="turn(page+1)"><ChevronRight :size="18"/></button></div></footer>
    <div v-if="detailOpen" class="modal-backdrop" @click.self="close" @keydown="trap"><section class="modal log-detail" role="dialog" aria-modal="true" aria-labelledby="operation-log-title">
      <div class="section-heading"><h2 id="operation-log-title">操作日志详情</h2><button ref="closeButton" type="button" class="icon-button" title="关闭" aria-label="关闭日志详情" @click="close"><X :size="18"/></button></div>
      <div v-if="detailLoading" class="empty-state"><LoaderCircle class="spin" :size="24"/></div><p v-if="detailError" role="alert" class="error-banner">{{detailError}}</p>
      <template v-if="detail"><dl class="log-metadata"><dt>操作人</dt><dd>{{actorLabel(detail)}}<small>{{detail.actorId}}</small></dd><dt>时间</dt><dd>{{formatDate(detail.createdAt,true)}}</dd><dt>模块 / 对象</dt><dd>{{OPERATION_LOG_MODULES[detail.module]}} / {{detail.objectName}}<small>{{detail.objectId}}</small></dd><dt>操作 / 结果</dt><dd>{{operationAction(detail.action)}} / {{OPERATION_LOG_RESULTS[detail.result]}}</dd><dt>变更依据</dt><dd>{{detail.reason??'历史未记录'}}</dd><dt>来源</dt><dd>{{detail.sourceTable}}<small>{{detail.sourceId}}</small></dd><dt>请求 ID</dt><dd>{{detail.requestId??'历史未记录'}}</dd><dt>执行主体</dt><dd>{{detail.executionPrincipal??detail.actorName??detail.actorId??'历史未记录'}}</dd></dl>
      <h3>{{detail.valueMeaning==='PROPOSED'?'提交内容差异（未代表生效）':'记录的字段差异'}}</h3>
      <p v-if="detail.beforeValue===null" class="muted">修改前快照未记录，或该操作为首次创建。</p>
      <div v-if="detail.changes.length" class="table-wrap"><table class="diff-table"><thead><tr><th>字段</th><th>修改前</th><th>{{detail.valueMeaning==='PROPOSED'?'拟修改为':'修改后'}}</th></tr></thead><tbody><tr v-for="(change,index) in detail.changes" :key="index"><td>{{change.field}}</td><td><pre>{{text(change.before)}}</pre></td><td><pre>{{text(change.after)}}</pre></td></tr></tbody></table></div><p v-else class="muted">无可展示的字段差异；历史字段可能未记录，敏感内容已排除。</p><p v-if="detail.changesTruncated" class="muted">仅展示前 200 项差异，请缩小到对应对象核查。</p>
      </template>
    </section></div>
  </section>
</template>
<style scoped>
.operation-logs{min-width:0}.log-filters{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;align-items:end;margin-bottom:22px}.log-filters label{display:grid;gap:7px;font-size:12px;min-width:0}.log-filters input,.log-filters select{width:100%;min-width:0}.log-query{grid-column:span 2}.log-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.operation-logs td{vertical-align:top;overflow-wrap:anywhere;font-size:12px}.operation-logs small{display:block;color:#65747c;font-size:11px;margin-top:5px;overflow-wrap:anywhere}.log-reason{max-width:220px;white-space:pre-wrap}.log-detail{width:min(1000px,calc(100vw - 32px));max-width:1000px;max-height:90vh;overflow:auto}.log-metadata{display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;font-size:13px}.log-metadata dt{color:#65747c}.log-metadata dd{margin:0;overflow-wrap:anywhere}.diff-table{table-layout:fixed;width:100%}.diff-table th:first-child{width:26%}.diff-table pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;margin:0;max-height:300px;overflow:auto}.log-detail h3{font-size:15px;margin-top:24px}.log-detail .muted{font-size:12px}@media(max-width:900px){.log-filters{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.log-filters{grid-template-columns:minmax(0,1fr)}.log-query{grid-column:auto}.log-detail{width:calc(100vw - 20px);padding:16px}.log-metadata{grid-template-columns:70px minmax(0,1fr)}.operation-logs>.table-wrap table{min-width:780px}.log-detail .diff-table{min-width:540px}}
</style>
