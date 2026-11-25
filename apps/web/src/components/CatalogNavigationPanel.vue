<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {Check,ChevronRight,Folder,FolderPlus,LoaderCircle,Plus,RefreshCw,Search,Undo2} from 'lucide-vue-next';
import type {CatalogTreeNode,CatalogTreeView} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import ContentBoundary from './ContentBoundary.vue';
import OperationLogLink from './OperationLogLink.vue';
const emit=defineEmits<{dirty:[value:boolean]}>();
const data=ref<CatalogTreeView>(),nodes=ref<CatalogTreeNode[]>([]),saved=ref(''),selected=ref('');
const query=ref(''),reason=ref(''),safe=ref(false),busy=ref(false),error=ref(''),notice=ref('');
type Preview={serviceCode:string;groupId:string;path:{name:string}[];candidates:{id:string;name:string;duty:string}[];warnings:string[]};
const preview=ref<Preview[]>([]);
const dirty=computed(()=>!!data.value&&JSON.stringify(nodes.value)!==saved.value);
watch(dirty,value=>emit('dirty',value));
watch(nodes,()=>{preview.value=[];safe.value=false;},{deep:true});
const node=computed(()=>nodes.value.find(n=>n.id===selected.value));
const original=computed(()=>data.value?.nodes.find(n=>n.id===selected.value));
const service=computed(()=>data.value?.services.find(s=>s.code===node.value?.serviceCode));
const parents=computed(()=>nodes.value.filter(n=>n.id!==node.value?.id&&(
  node.value?.kind==='CATEGORY'||node.value?.kind==='SYSTEM'?n.kind==='CATEGORY'&&n.parentId===null:
    n.kind==='SYSTEM'||n.kind==='CATEGORY'
)));
const bindings=computed(()=>data.value?.services.filter(s=>s.code===node.value?.serviceCode||!nodes.value.some(n=>n.serviceCode===s.code))??[]);
const visible=computed(()=>{
  const rows:{node:CatalogTreeNode;depth:number}[]=[],words=query.value.trim().toLocaleLowerCase();
  const matches=(n:CatalogTreeNode,depth=0):boolean=>`${n.name} ${n.serviceCode??''}`.toLocaleLowerCase().includes(words)||depth<2&&nodes.value.some(c=>c.parentId===n.id&&matches(c,depth+1));
  const visit=(parentId:string|null,depth:number)=>{for(const n of nodes.value.filter(n=>n.parentId===parentId).sort((a,b)=>a.sortOrder-b.sortOrder||a.id.localeCompare(b.id))){
    if(!words||matches(n))rows.push({node:n,depth});if(depth<2)visit(n.id,depth+1);
  }};visit(null,0);return rows;
});
const invalid=computed(()=>nodes.value.some(n=>!n.name.trim()||!Number.isInteger(n.sortOrder)||n.sortOrder<0||n.sortOrder>99999
  ||n.kind==='SYSTEM'&&n.enabled&&!n.systemId||n.kind==='SERVICE'&&n.enabled&&!n.serviceCode));
const payload=()=>({expectedVersion:data.value!.version,navigationVersion:data.value!.navigationVersion,structureVersion:data.value!.structureVersion,
  nodes:nodes.value,reason:reason.value.trim(),contentClass:'GENERAL'});
async function load(){busy.value=true;error.value='';try{
  const result=await api<CatalogTreeView>('/admin/catalog-navigation/tree');data.value=result;nodes.value=structuredClone(result.nodes);
  saved.value=JSON.stringify(result.nodes);if(!nodes.value.some(n=>n.id===selected.value))selected.value=nodes.value[0]?.id??'';
  reason.value='';safe.value=false;preview.value=[];return true;
}catch(e){error.value=errorText(e);return false;}finally{busy.value=false;}}
function reset(){nodes.value=JSON.parse(saved.value);reason.value='';safe.value=false;notice.value='';}
function add(kind:CatalogTreeNode['kind'],nested=false){
  const parent=kind==='CATEGORY'?(nested&&node.value?.kind==='CATEGORY'&&node.value.parentId===null?node.value.id:nested?undefined:null):
    node.value?.kind==='CATEGORY'&&(kind==='SERVICE'||node.value.parentId===null)||kind==='SERVICE'&&node.value?.kind==='SYSTEM'?node.value.id:undefined;
  if(parent===undefined)return;
  const item:CatalogTreeNode={id:`node-${createRequestKey()}`,parentId:parent,kind,name:kind==='CATEGORY'?'新分类':kind==='SYSTEM'?'新业务系统':'新服务事项',enabled:false,sortOrder:100,systemId:null,serviceCode:null};
  let suffix=1;while(nodes.value.some(n=>n.parentId===item.parentId&&n.name===item.name))item.name=`${kind==='CATEGORY'?'新分类':kind==='SYSTEM'?'新业务系统':'新服务事项'} ${suffix++}`;
  nodes.value.push(item);selected.value=item.id;
}
function removeDraft(){if(!node.value||original.value||nodes.value.some(n=>n.parentId===node.value!.id))return;nodes.value=nodes.value.filter(n=>n.id!==selected.value);selected.value=nodes.value[0]?.id??'';}
async function check(){if(!data.value||invalid.value||!reason.value.trim())return;busy.value=true;error.value='';try{preview.value=(await api<{items:Preview[]}>('/admin/catalog-navigation/tree/preview',{method:'POST',body:payload()})).items;}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function save(){if(!data.value||invalid.value||!reason.value.trim()||!safe.value||busy.value||data.value.version>0&&!dirty.value)return;
  busy.value=true;error.value='';notice.value='';try{await api('/admin/catalog-navigation/tree',{method:'POST',body:payload()});if(await load())notice.value='服务目录已保存并生效';}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
const warningLabels:Record<string,string>={UNPUBLISHED:'未发布',DIRECTORY_UNASSIGNED:'未绑定目录',DIRECTORY_DISABLED:'目录已停用',SYSTEM_MAPPING_MISMATCH:'系统与服务映射不一致',ROUTE_UNAVAILABLE:'岗位映射待配置',NO_ACTIVE_ENGINEER:'当前无有效工程师'};
const warningLabel=(value:string)=>warningLabels[value]??value;
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue='';}}
onMounted(()=>{window.addEventListener('beforeunload',beforeUnload);void load();});
onBeforeUnmount(()=>{window.removeEventListener('beforeunload',beforeUnload);emit('dirty',false);});
</script>
<template>
  <section class="navigation-panel" aria-label="目录展示配置" :aria-busy="busy">
    <p v-if="error" role="alert" class="error-banner">{{error}}</p><p v-if="notice" role="status" class="success-banner">{{notice}}</p>
    <div class="section-heading"><span class="muted">目录版本 {{data?.version??'—'}}<span v-if="data?.version===0"> · 待首次启用</span></span><div class="navigation-tools"><button class="icon-button" aria-label="放弃目录展示修改" title="放弃目录展示修改" :disabled="busy||!dirty" @click="reset"><Undo2 :size="17"/></button><button class="icon-button" aria-label="刷新目录展示" title="刷新目录展示" :disabled="busy||dirty" @click="load"><RefreshCw :size="17" :class="{spin:busy}"/></button></div></div>
    <div class="tree-layout">
      <div class="tree-list"><label class="navigation-search"><Search :size="17"/><input v-model="query" type="search" aria-label="查找目录服务" placeholder="查找服务或分类"/></label>
        <button class="secondary" :disabled="busy" @click="add('CATEGORY')"><FolderPlus :size="16"/>新增一级目录</button>
        <nav aria-label="服务目录树"><button v-for="row in visible" :key="row.node.id" class="tree-row" :class="{selected:selected===row.node.id,muted:!row.node.enabled}" :style="{paddingLeft:`${12+row.depth*18}px`}" :aria-pressed="selected===row.node.id" @click="selected=row.node.id"><ChevronRight v-if="row.node.kind!=='SERVICE'" :size="14"/><Folder v-else :size="14"/><span>{{row.node.name}}<small v-if="row.node.serviceCode">{{row.node.serviceCode}}</small></span><small v-if="!row.node.enabled">停用</small></button></nav>
      </div>
      <div v-if="node" class="tree-editor">
        <h3>{{node.name}}</h3>
        <label>目录名称<input v-model="node.name" maxlength="80" aria-label="目录名称" :disabled="busy"/></label>
        <label v-if="node.kind!=='CATEGORY'||node.parentId">上级目录<select v-model="node.parentId" aria-label="上级目录" :disabled="busy"><option v-for="item in parents" :key="item.id" :value="item.id">{{item.name}}</option></select></label>
        <label v-if="node.kind==='SYSTEM'">业务系统<select v-model="node.systemId" aria-label="关联业务系统" :disabled="busy||!!original?.systemId"><option :value="null">请选择</option><option v-for="item in data?.systems" :key="item.id" :value="item.id">{{item.name}}{{!item.enabled?'（已停用）':''}}</option></select></label>
        <label v-if="node.kind==='SERVICE'">关联服务<select v-model="node.serviceCode" aria-label="关联服务编码" :disabled="busy||!!original?.serviceCode"><option :value="null">未绑定（草稿）</option><option v-for="item in bindings" :key="item.code" :value="item.code">{{item.name}} · {{item.code}}</option></select></label>
        <label>排序<input v-model.number="node.sortOrder" type="number" min="0" max="99999" step="1" aria-label="目录排序" :disabled="busy"/></label>
        <label class="checkbox-label"><input v-model="node.enabled" type="checkbox" :disabled="busy"/>启用此目录</label>
        <p v-if="service" class="muted">{{service.published?'已发布':'未发布'}} · {{service.mapped?(service.staffed?'岗位与当前人员已配置':'待配置当前人员'):'待配置服务映射'}}</p>
        <div class="navigation-tools"><button v-if="node.kind==='CATEGORY'&&node.parentId===null" class="secondary" :disabled="busy" @click="add('CATEGORY',true)"><FolderPlus :size="16"/>新增二级分类</button><button v-if="node.kind==='CATEGORY'&&node.parentId===null" class="secondary" :disabled="busy" @click="add('SYSTEM')"><Plus :size="16"/>新增业务系统</button><button v-if="node.kind!=='SERVICE'" class="secondary" :disabled="busy" @click="add('SERVICE')"><Plus :size="16"/>新增服务事项</button><button v-if="!original&&!nodes.some(n=>n.parentId===node!.id)" class="secondary" :disabled="busy" @click="removeDraft">移除草稿</button></div>
      </div>
    </div>
    <label>变更原因<textarea v-model="reason" rows="2" maxlength="500" aria-label="目录展示变更原因" :disabled="busy"/></label>
    <ContentBoundary v-model="safe"/>
    <div class="section-heading"><OperationLogLink module="catalog-navigation"/><div class="navigation-tools"><button class="secondary" :disabled="busy||invalid||!reason.trim()" @click="check">检查目录与承接</button><button class="primary" :disabled="busy||invalid||!safe||!reason.trim()||data?.version!==0&&!dirty" @click="save"><LoaderCircle v-if="busy" :size="17" class="spin"/><Check v-else :size="17"/>保存并生效</button></div></div>
    <div v-if="preview.length" class="table-wrap"><table><thead><tr><th>服务</th><th>目录</th><th>当前工程师</th><th>检查结果</th></tr></thead><tbody><tr v-for="item in preview" :key="item.serviceCode"><td>{{item.serviceCode}}</td><td>{{item.path.map(n=>n.name).join(' / ')||'待绑定'}}</td><td>{{item.candidates.map(p=>p.name).join('、')||'—'}}</td><td>{{item.warnings.map(warningLabel).join('；')||'可承接'}}</td></tr></tbody></table></div>
  </section>
</template>
<style scoped>
.navigation-panel{display:grid;gap:16px}.navigation-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.navigation-search{display:flex;gap:8px;align-items:center}.navigation-search input{width:100%}.tree-layout{display:grid;grid-template-columns:minmax(240px,2fr) minmax(260px,3fr);gap:24px}.tree-list{display:grid;gap:12px;align-content:start}.tree-list nav{max-height:560px;overflow:auto;border-top:1px solid var(--line,#e5e7eb)}.tree-row{width:100%;display:flex;align-items:center;gap:8px;text-align:left;border:0;border-bottom:1px solid var(--line,#e5e7eb);border-radius:0;padding:10px;background:transparent}.tree-row.selected{background:var(--soft,#eef5f1);color:var(--ink,#162d24)}.tree-row span{flex:1;min-width:0;overflow-wrap:anywhere}.tree-row small{display:block;font-size:11px}.tree-editor{display:grid;gap:14px;align-content:start;border-left:1px solid var(--line,#e5e7eb);padding-left:24px}.tree-editor label,.navigation-panel>label{display:grid;gap:6px}.tree-editor .checkbox-label{display:flex}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid var(--line,#e5e7eb);font-size:13px}@media(max-width:700px){.tree-layout{grid-template-columns:minmax(0,1fr)}.tree-editor{border-left:0;border-top:1px solid var(--line,#e5e7eb);padding:16px 0 0}.tree-list nav{max-height:300px}}
</style>
