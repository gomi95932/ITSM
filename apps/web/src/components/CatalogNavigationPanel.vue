<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {Check,LoaderCircle,RefreshCw,Search,Undo2} from 'lucide-vue-next';
import type {CatalogNavigationEntry,CatalogNavigationView} from '@itsm/contracts';
import {api,errorText} from '../api';
import {formatDate} from '../labels';
import ContentBoundary from './ContentBoundary.vue';
const emit=defineEmits<{dirty:[value:boolean]}>();
const data=ref<CatalogNavigationView>(),items=ref<CatalogNavigationEntry[]>([]),saved=ref('');
const query=ref(''),reason=ref(''),safe=ref(false),busy=ref(false),error=ref(''),notice=ref('');
const dirty=computed(()=>!!data.value&&JSON.stringify(items.value)!==saved.value);
watch(dirty,value=>emit('dirty',value));
const services=computed(()=>new Map(data.value?.services.map(row=>[row.code,row])??[]));
const visible=computed(()=>items.value.filter(row=>[row.serviceCode,services.value.get(row.serviceCode)?.name,...row.path].join(' ').toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const categories=computed(()=>[...new Set(items.value.map(row=>row.path[0]).filter(Boolean))]);
const invalid=computed(()=>items.value.some(row=>!row.path[0]?.trim()||row.path.some(p=>p.trim().length>80)
  ||!Number.isInteger(row.sortOrder)||row.sortOrder<0||row.sortOrder>99999));
function setSubcategory(row:CatalogNavigationEntry,value:string){row.path=value.trim()?[row.path[0],value]:[row.path[0]];}
async function load(){
  busy.value=true;error.value='';
  try{const result=await api<CatalogNavigationView>('/admin/catalog-navigation');data.value=result;
    items.value=result.items;saved.value=JSON.stringify(result.items);reason.value='';safe.value=false;return true;
  }catch(e){error.value=errorText(e);return false;}finally{busy.value=false;}
}
function reset(){items.value=JSON.parse(saved.value);notice.value='';reason.value='';safe.value=false;}
async function save(){
  if(!data.value||!dirty.value||invalid.value||!safe.value||!reason.value.trim()||busy.value)return;
  busy.value=true;error.value='';notice.value='';
  try{await api('/admin/catalog-navigation',{method:'POST',body:{expectedVersion:data.value.version,
    items:items.value,reason:reason.value,contentClass:'GENERAL'}});
    if(await load())notice.value='目录展示已保存并生效';
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue='';}}
onMounted(()=>{window.addEventListener('beforeunload',beforeUnload);void load();});
onBeforeUnmount(()=>{window.removeEventListener('beforeunload',beforeUnload);emit('dirty',false);});
</script>
<template>
  <section class="navigation-panel" aria-label="目录展示配置" :aria-busy="busy">
    <p v-if="error" role="alert" class="error-banner">{{error}}</p><p v-if="notice" role="status" class="success-banner">{{notice}}</p>
    <div class="section-heading"><span class="muted">展示版本 {{data?.version??'—'}}</span><div class="navigation-tools"><button class="icon-button" aria-label="放弃目录展示修改" title="放弃目录展示修改" :disabled="busy||!dirty" @click="reset"><Undo2 :size="17"/></button><button class="icon-button" aria-label="刷新目录展示" title="刷新目录展示" :disabled="busy||dirty" @click="load"><RefreshCw :size="17" :class="{spin:busy}"/></button></div></div>
    <label class="navigation-search"><Search :size="17"/><input v-model="query" type="search" aria-label="查找目录服务" placeholder="查找服务或分类"/></label>
    <datalist id="navigation-categories"><option v-for="name in categories" :key="name" :value="name"/></datalist>
    <div class="table-wrap"><table><thead><tr><th>服务</th><th>一级分类</th><th>二级分类 / 系统（选填）</th><th>排序</th><th>发布与承接状态</th></tr></thead><tbody>
      <tr v-for="row in visible" :key="row.serviceCode"><td><strong>{{services.get(row.serviceCode)?.name}}</strong><small>{{row.serviceCode}}</small></td>
        <td><input v-model="row.path[0]" list="navigation-categories" maxlength="80" :aria-label="`${row.serviceCode}一级分类`" :disabled="busy"/></td>
        <td><input :value="row.path[1]??''" maxlength="80" :aria-label="`${row.serviceCode}二级分类`" :disabled="busy" @input="setSubcategory(row,($event.target as HTMLInputElement).value)"/></td>
        <td><input v-model.number="row.sortOrder" type="number" min="0" max="99999" step="1" :aria-label="`${row.serviceCode}排序`" :disabled="busy"/></td>
        <td><span>{{services.get(row.serviceCode)?.published?'已发布':'未发布'}}</span><small :class="{'danger-text':!services.get(row.serviceCode)?.staffed}">{{services.get(row.serviceCode)?.mapped?(services.get(row.serviceCode)?.staffed?'已配置岗位和当前人员':'岗位待配置当前人员'):'待配置服务映射'}}</small></td>
      </tr>
    </tbody></table></div>
    <p v-if="data&&!visible.length" class="muted">没有匹配的服务</p>
    <form v-if="dirty" class="navigation-publish" @submit.prevent="save"><label>变更依据<textarea v-model="reason" maxlength="500" required rows="2" :disabled="busy"/></label><ContentBoundary v-model="safe"/><button class="primary" :disabled="busy||invalid||!safe||!reason.trim()"><LoaderCircle v-if="busy" :size="17" class="spin"/><Check v-else :size="17"/>保存目录展示</button></form>
    <details v-if="data?.history.length" class="navigation-history"><summary>展示变更记录</summary><ul><li v-for="row in data.history" :key="row.version"><strong>版本 {{row.version}}</strong> · {{row.actorName??'系统初始化'}} · {{formatDate(row.createdAt)}}<p>{{row.reason}}</p></li></ul></details>
  </section>
</template>
<style scoped>
.navigation-panel{min-width:0}.navigation-tools{display:flex;gap:8px}.navigation-search{display:flex;align-items:center;gap:8px;max-width:450px;margin:16px 0}.navigation-search input{min-width:0;width:100%}.navigation-panel table{min-width:820px;width:100%;table-layout:fixed}.navigation-panel th:nth-child(1){width:23%}.navigation-panel th:nth-child(4){width:90px}.navigation-panel td{vertical-align:top;overflow-wrap:anywhere}.navigation-panel td input{width:100%;min-width:0}.navigation-panel small{display:block;margin-top:6px;font-size:11px;color:#65747c}.navigation-panel small.danger-text{color:#a64d22}.navigation-publish{display:grid;gap:16px;margin-top:24px;border-top:1px solid #dfe5e8;padding-top:20px}.navigation-publish>label{display:grid;gap:8px;font-size:13px}.navigation-publish>button{justify-self:start}.navigation-history{margin-top:24px;font-size:13px}.navigation-history summary{cursor:pointer}.navigation-history ul{padding-left:20px}.navigation-history li{padding:10px 0;overflow-wrap:anywhere}.navigation-history p{margin:6px 0;color:#65747c}
</style>
