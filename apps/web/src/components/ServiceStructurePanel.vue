<script setup lang="ts">
import { computed,nextTick,onMounted,ref,watch } from 'vue';
import { Ban,Check,ChevronRight,Eye,LoaderCircle,Pencil,Plus,RefreshCw,Search,Undo2,X } from 'lucide-vue-next';
import type { ServiceCatalogAdminItem,ServiceCatalogChange,ServicePositionMapping,ServiceStructure,ServiceStructureChange,ServiceStructureOptions,ServiceStructurePreview,SessionUser } from '@itsm/contracts';
import { api,errorText } from '../api';
import { createRequestKey } from '../request-key';
import { formatDate } from '../labels';
import ContentBoundary from './ContentBoundary.vue';
import ServiceCatalogEditor from './ServiceCatalogEditor.vue';
import ServiceCatalogSummary from './ServiceCatalogSummary.vue';

const props=defineProps<{user:SessionUser}>();
type StructureTab=keyof ServiceStructure;
type Tab=StructureTab|'catalog'|'changes';
type Person={id:string;name:string;groups:string[];dingLinked:boolean};
const empty=():ServiceStructure=>({domains:[],systems:[],positions:[],appointments:[],mappings:[]});
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const labels:Record<Tab,string>={domains:'责任域',systems:'业务系统',positions:'岗位',appointments:'任职人员',catalog:'目录维护',mappings:'服务映射',changes:'变更复核'};
const states:Record<string,string>={PENDING:'待独立复核',APPROVED:'已发布',REJECTED:'已拒绝'};
const warningLabels:Record<string,string>={NO_CURRENT_APPOINTEE:'当前无有效任职人员',DING_ID_NOT_LINKED:'部分人员未绑定企业钉钉',CATALOG_NOT_PUBLISHED:'服务目录尚未发布'};
const tab=ref<Tab>('domains'),draft=ref<ServiceStructure>(empty()),published=ref<ServiceStructure>(empty()),version=ref(1);
const options=ref<ServiceStructureOptions>({groups:[],services:[],people:[]}),items=ref<ServiceStructureChange[]>([]);
const catalogItems=ref<ServiceCatalogAdminItem[]>([]),catalogMore=ref(false),catalogChange=ref<ServiceCatalogChange>();
const loading=ref(true),busy=ref(false),error=ref(''),notice=ref(''),reason=ref(''),safe=ref(false),proposalId=ref(createRequestKey());
const preview=ref<ServiceStructurePreview[]>(),inspecting=ref<ServiceStructureChange>(),reviewReason=ref(''),reviewSafe=ref(false);
const people=ref<Person[]>([]),query=ref(''),searchMore=ref(false),editing=ref(false),editKey=ref('');
const form=ref({id:'',name:'',domainId:'',groupId:'',enabled:true,positionId:'',employeeId:'',duty:'PRIMARY' as 'PRIMARY'|'BACKUP',
  validFrom:'',validTo:'',serviceCode:'',systemId:'',primaryPositionId:'',collaboratingPositionIds:[] as string[]});
const config=computed(()=>inspecting.value?.config??draft.value);
const dirty=computed(()=>!!catalogChange.value||JSON.stringify(draft.value)!==JSON.stringify(published.value));
const structureTab=computed(()=>tab.value!=='catalog'&&tab.value!=='changes'?tab.value:undefined);
const services=computed(()=>catalogChange.value?[...options.value.services.filter(s=>s.code!==catalogChange.value!.code),catalogChange.value]:options.value.services);
const selectedPosition=computed(()=>draft.value.positions.find(row=>row.id===form.value.positionId));
const eligiblePeople=computed(()=>people.value.filter(person=>person.groups.includes(selectedPosition.value?.groupId??'')));
const allPeople=computed(()=>new Map([...options.value.people,...people.value].map(person=>[person.id,person])));
const domainName=(id:string)=>config.value.domains.find(row=>row.id===id)?.name??id;
const systemName=(id:string|null)=>config.value.systems.find(row=>row.id===id)?.name??id??'—';
const positionName=(id:string)=>config.value.positions.find(row=>row.id===id)?.name??id;
const groupName=(id:string)=>options.value.groups.find(row=>row.id===id)?.name??id;
const personName=(id:string)=>allPeople.value.get(id)?.name??id;
const serviceName=(code:string)=>inspecting.value?.catalogChange?.code===code?inspecting.value.catalogChange.name:services.value.find(row=>row.code===code)?.name??code;
const ownProposal=computed(()=>inspecting.value?.proposedBy===props.user.id);
watch([draft,reason,catalogChange],()=>{preview.value=undefined;safe.value=false;proposalId.value=createRequestKey();notice.value='';},{deep:true});
watch(reviewReason,()=>{reviewSafe.value=false;});
watch(()=>form.value.positionId,()=>{if(!editKey.value)form.value.employeeId='';});

async function load(){
  if(busy.value)return;loading.value=true;error.value='';
  try{
    const [result,catalog]=await Promise.all([
      api<{version:number;config:ServiceStructure;options:ServiceStructureOptions;items:ServiceStructureChange[]}>('/admin/service-structure'),
      api<{version:number;items:ServiceCatalogAdminItem[];hasMore:boolean}>('/admin/service-structure/catalog')]);
    if(result.version!==catalog.version)throw new Error('配置在加载期间已更新，请刷新。');
    version.value=result.version;published.value=copy(result.config);draft.value=copy(result.config);options.value=result.options;items.value=result.items;
    catalogItems.value=catalog.items;catalogMore.value=catalog.hasMore;catalogChange.value=undefined;
    editing.value=false;preview.value=undefined;
  }catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
function reset(){draft.value=copy(published.value);catalogChange.value=undefined;editing.value=false;reason.value='';}
function saveCatalog(change:ServiceCatalogChange,mapping:ServicePositionMapping){
  catalogChange.value=copy(change);
  const index=draft.value.mappings.findIndex(m=>m.serviceCode===mapping.serviceCode);
  if(index<0)draft.value.mappings.push(mapping);else draft.value.mappings.splice(index,1,mapping);
}
function cancelCatalog(){
  const code=catalogChange.value?.code;if(!code)return;
  draft.value.mappings=draft.value.mappings.filter(m=>m.serviceCode!==code);
  const previous=published.value.mappings.find(m=>m.serviceCode===code);if(previous)draft.value.mappings.push(copy(previous));
  catalogChange.value=undefined;
}
function localTime(value:string){
  const date=new Date(value),pad=(n:number)=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function edit(key=''){
  if(tab.value==='changes'||tab.value==='catalog'||inspecting.value)return;
  editKey.value=key;const now=new Date();
  form.value={id:key||createRequestKey(),name:'',domainId:'',groupId:'',enabled:true,positionId:'',employeeId:'',duty:'PRIMARY',
    validFrom:localTime(now.toISOString()),validTo:localTime(new Date(now.getTime()+90*86400000).toISOString()),
    serviceCode:'',systemId:'',primaryPositionId:'',collaboratingPositionIds:[]};
  const collection=draft.value[tab.value];
  const found=collection.find(row=>('id' in row?row.id:row.serviceCode)===key);
  if(found){
    Object.assign(form.value,copy(found));
    if('systemId' in found)form.value.systemId=found.systemId??'';
    if('validFrom' in found){form.value.validFrom=localTime(found.validFrom);form.value.validTo=localTime(found.validTo);}
    if('employeeId' in found&&!people.value.some(person=>person.id===found.employeeId)){
      const person=options.value.people.find(row=>row.id===found.employeeId);if(person)people.value.push(person);
    }
  }
  editing.value=true;error.value='';
}
function apply(){
  const f=form.value;
  let row:ServiceStructure[StructureTab][number];
  if(tab.value==='domains')row={id:f.id,name:f.name.trim(),enabled:f.enabled};
  else if(tab.value==='systems')row={id:f.id,name:f.name.trim(),domainId:f.domainId,enabled:f.enabled};
  else if(tab.value==='positions')row={id:f.id,name:f.name.trim(),domainId:f.domainId,groupId:f.groupId,enabled:f.enabled};
  else if(tab.value==='appointments'){
    if(!Number.isFinite(Date.parse(f.validFrom))||!Number.isFinite(Date.parse(f.validTo))||Date.parse(f.validTo)<=Date.parse(f.validFrom)){
      error.value='任职截止时间须晚于开始时间。';return;
    }
    row={id:f.id,positionId:f.positionId,employeeId:f.employeeId,duty:f.duty,
      validFrom:new Date(f.validFrom).toISOString(),validTo:new Date(f.validTo).toISOString(),enabled:f.enabled};
  }else if(tab.value==='mappings')row={serviceCode:f.serviceCode,domainId:f.domainId,systemId:f.systemId||null,
    primaryPositionId:f.primaryPositionId,collaboratingPositionIds:[...f.collaboratingPositionIds].sort(),enabled:f.enabled};
  else return;
  const collection=draft.value[tab.value] as typeof row[],key='id' in row?row.id:row.serviceCode;
  if(!editKey.value&&collection.some(item=>('id' in item?item.id:item.serviceCode)===key)){error.value='该配置已存在，请编辑已有记录。';return;}
  const index=collection.findIndex(item=>('id' in item?item.id:item.serviceCode)===editKey.value);
  if(index<0)collection.push(row);else collection.splice(index,1,row);
  editing.value=false;error.value='';
}
async function search(){
  if(busy.value||query.value.trim().length<2)return;busy.value=true;error.value='';
  try{const result=await api<{items:Person[];hasMore:boolean}>(`/admin/service-structure/people?q=${encodeURIComponent(query.value.trim())}`);
    people.value=result.items;searchMore.value=result.hasMore;
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
function body(){return {id:proposalId.value,expectedVersion:version.value,config:draft.value,reason:reason.value,contentClass:'GENERAL',
  ...(catalogChange.value?{catalogChange:catalogChange.value}:{})};}
async function check(){
  if(busy.value||!safe.value||!reason.value.trim())return;busy.value=true;error.value='';
  try{preview.value=(await api<{items:ServiceStructurePreview[]}>('/admin/service-structure/preview',{method:'POST',body:body()})).items;}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function submit(){
  if(busy.value||!preview.value||!safe.value)return;busy.value=true;error.value='';
  try{await api('/admin/service-structure',{method:'POST',body:body()});busy.value=false;await load();tab.value='changes';reason.value='';await nextTick();notice.value='配置已提交独立复核，尚未生效。';}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
function inspect(item:ServiceStructureChange){inspecting.value=item;tab.value='domains';editing.value=false;reviewReason.value='';reviewSafe.value=false;preview.value=undefined;error.value='';}
async function review(decision:'APPROVE'|'REJECT'){
  if(!inspecting.value||busy.value||!reviewSafe.value||!reviewReason.value.trim())return;
  busy.value=true;error.value='';
  try{
    await api(`/admin/service-structure/${inspecting.value.id}/review`,{method:'POST',body:{expectedVersion:inspecting.value.version,decision,reason:reviewReason.value,contentClass:'GENERAL'}});
    inspecting.value=undefined;busy.value=false;await load();tab.value='changes';await nextTick();notice.value=decision==='APPROVE'?'配置已发布。':'配置已拒绝。';
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
onMounted(load);
</script>

<template>
  <div class="structure-panel" :aria-busy="loading||busy">
    <p v-if="error" class="error-banner" role="alert">{{error}}</p><p v-if="notice" class="success-banner" role="status">{{notice}}</p>
    <header class="section-heading"><span class="muted">已发布版本 {{version}} <span v-if="dirty">· 未提交修改</span></span><div class="structure-tools">
      <button v-if="dirty&&!inspecting" class="icon-button" title="放弃未提交修改" aria-label="放弃未提交修改" :disabled="busy" @click="reset"><Undo2 :size="17"/></button>
      <button class="icon-button" title="刷新服务组织" aria-label="刷新服务组织" :disabled="busy||loading||dirty||!!inspecting" @click="load"><RefreshCw :size="17" :class="{spin:loading}"/></button>
      <button v-if="structureTab&&!inspecting" class="primary" :disabled="busy||loading" @click="edit()"><Plus :size="17"/>新增{{labels[tab]}}</button>
    </div></header>
    <section v-if="inspecting" class="detail-section review-section" aria-label="配置复核">
      <div class="section-heading"><h2>配置复核 · {{states[inspecting.status]}}</h2><button class="icon-button" title="返回编辑配置" aria-label="返回编辑配置" :disabled="busy" @click="inspecting=undefined;tab='changes'"><X :size="18"/></button></div>
      <p>基于版本 {{inspecting.expectedVersion}} · 提交人 {{personName(inspecting.proposedBy)}} · {{formatDate(inspecting.createdAt)}}</p>
      <p>{{inspecting.reason}}</p>
      <ServiceCatalogSummary v-if="inspecting.catalogChange" :change="inspecting.catalogChange"/>
      <p v-if="inspecting.expectedVersion!==version&&inspecting.status==='PENDING'" class="danger-text">基线版本已变化，此提案不能发布。</p>
      <form v-if="inspecting.status==='PENDING'&&!ownProposal" class="action-form" @submit.prevent="review('APPROVE')">
        <label>复核依据<textarea v-model="reviewReason" required maxlength="500" rows="2"/></label><ContentBoundary v-model="reviewSafe"/>
        <div class="structure-tools"><button class="primary" :disabled="busy||!reviewSafe||!reviewReason.trim()||inspecting.expectedVersion!==version"><Check :size="16"/>批准发布</button><button type="button" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review('REJECT')"><Ban :size="16"/>拒绝</button></div>
      </form>
    </section>
    <nav class="structure-tabs" role="tablist" aria-label="服务组织配置">
      <button v-for="(label,key) in labels" :key="key" role="tab" :aria-selected="tab===key" :class="{active:tab===key}" :disabled="busy||!!inspecting&&key==='changes'" @click="tab=key;editing=false">{{label}}</button>
    </nav>
    <section v-if="editing&&!inspecting" class="detail-section" :aria-label="`编辑${labels[tab]}`">
      <div class="section-heading"><h2>{{editKey?'编辑':'新增'}}{{labels[tab]}}</h2><button class="icon-button" title="取消编辑" aria-label="取消编辑" @click="editing=false"><X :size="18"/></button></div>
      <form class="action-form" @submit.prevent="apply">
        <div class="form-grid">
          <label v-if="['domains','systems','positions'].includes(tab)">名称<input v-model="form.name" required maxlength="100"/></label>
          <label v-if="['systems','positions','mappings'].includes(tab)">责任域<select v-model="form.domainId" required><option value="">请选择</option><option v-for="d in draft.domains" :key="d.id" :value="d.id">{{d.name}}{{d.enabled?'':'（停用）'}}</option></select></label>
          <label v-if="tab==='positions'">支持组<select v-model="form.groupId" required><option value="">请选择</option><option v-for="g in options.groups" :key="g.id" :value="g.id">{{g.name}}</option></select></label>
          <template v-if="tab==='appointments'">
            <label>岗位<select v-model="form.positionId" required><option value="">请选择</option><option v-for="p in draft.positions" :key="p.id" :value="p.id">{{p.name}} · {{groupName(p.groupId)}}</option></select></label>
            <label>主备<select v-model="form.duty"><option value="PRIMARY">主处理</option><option value="BACKUP">备岗</option></select></label>
            <label>查找人员<div class="structure-search"><input v-model="query" aria-label="查找任职人员" maxlength="100"/><button type="button" class="icon-button" title="搜索人员" aria-label="搜索人员" :disabled="busy||query.trim().length<2" @click="search"><Search :size="17"/></button></div></label>
            <label>任职人员<select v-model="form.employeeId" required :disabled="!form.positionId"><option value="">请选择</option><option v-for="p in eligiblePeople" :key="p.id" :value="p.id">{{p.name}} · {{p.id}}{{p.dingLinked?'':' · 未绑定钉钉'}}</option><option v-if="form.employeeId&&!eligiblePeople.some(p=>p.id===form.employeeId)" :value="form.employeeId">{{personName(form.employeeId)}}</option></select></label>
            <label>生效时间<input v-model="form.validFrom" type="datetime-local" required/></label><label>截止时间<input v-model="form.validTo" type="datetime-local" required/></label>
            <p v-if="searchMore" class="muted">匹配超过 50 人</p>
          </template>
          <template v-if="tab==='mappings'">
            <label>服务项<select v-model="form.serviceCode" required :disabled="!!editKey"><option value="">请选择</option><option v-for="s in services" :key="s.code" :value="s.code">{{s.name}} · {{s.code}}</option></select></label>
            <label>业务系统<select v-model="form.systemId"><option value="">无关联</option><option v-for="s in draft.systems.filter(s=>s.domainId===form.domainId)" :key="s.id" :value="s.id">{{s.name}}</option></select></label>
            <label>主办岗位<select v-model="form.primaryPositionId" required><option value="">请选择</option><option v-for="p in draft.positions.filter(p=>p.domainId===form.domainId)" :key="p.id" :value="p.id">{{p.name}} · {{groupName(p.groupId)}}</option></select></label>
          </template>
          <label class="structure-toggle"><input v-model="form.enabled" type="checkbox"/>启用</label>
        </div>
        <fieldset v-if="tab==='mappings'" class="collaborators"><legend>协办岗位</legend><label v-for="p in draft.positions.filter(p=>p.id!==form.primaryPositionId)" :key="p.id" class="structure-toggle"><input v-model="form.collaboratingPositionIds" type="checkbox" :value="p.id"/>{{p.name}} · {{groupName(p.groupId)}}</label></fieldset>
        <div class="form-footer"><button class="primary"><Check :size="16"/>确认修改</button></div>
      </form>
    </section>
    <div v-if="loading" class="empty-state"><LoaderCircle class="spin" :size="26"/></div>
    <ServiceCatalogEditor v-else-if="tab==='catalog'&&!inspecting" :items="catalogItems" :config="draft" :options="options" :user="user" :change="catalogChange" :busy="busy" :has-more="catalogMore" @save="saveCatalog" @cancel="cancelCatalog"/>
    <ServiceCatalogSummary v-else-if="tab==='catalog'&&inspecting?.catalogChange" :change="inspecting.catalogChange"/>
    <p v-else-if="tab==='catalog'" class="structure-empty">此提案不包含目录变更</p>
    <div v-else class="table-wrap structure-table">
      <table v-if="tab==='domains'"><thead><tr><th>责任域</th><th>状态</th><th/></tr></thead><tbody><tr v-for="d in config.domains" :key="d.id"><td><strong>{{d.name}}</strong><small class="mono">{{d.id}}</small></td><td>{{d.enabled?'启用':'停用'}}</td><td><button v-if="!inspecting" class="icon-button" :aria-label="`编辑${d.name}`" title="编辑责任域" @click="edit(d.id)"><Pencil :size="16"/></button></td></tr></tbody></table>
      <table v-else-if="tab==='systems'"><thead><tr><th>业务系统</th><th>责任域</th><th>状态</th><th/></tr></thead><tbody><tr v-for="s in config.systems" :key="s.id"><td><strong>{{s.name}}</strong><small class="mono">{{s.id}}</small></td><td>{{domainName(s.domainId)}}</td><td>{{s.enabled?'启用':'停用'}}</td><td><button v-if="!inspecting" class="icon-button" :aria-label="`编辑${s.name}`" title="编辑业务系统" @click="edit(s.id)"><Pencil :size="16"/></button></td></tr></tbody></table>
      <table v-else-if="tab==='positions'"><thead><tr><th>岗位</th><th>责任域 / 支持组</th><th>状态</th><th/></tr></thead><tbody><tr v-for="p in config.positions" :key="p.id"><td><strong>{{p.name}}</strong><small class="mono">{{p.id}}</small></td><td>{{domainName(p.domainId)}}<small>{{groupName(p.groupId)}}</small></td><td>{{p.enabled?'启用':'停用'}}</td><td><button v-if="!inspecting" class="icon-button" :aria-label="`编辑${p.name}`" title="编辑岗位" @click="edit(p.id)"><Pencil :size="16"/></button></td></tr></tbody></table>
      <table v-else-if="tab==='appointments'"><thead><tr><th>任职人员</th><th>岗位 / 主备</th><th>任职期间</th><th>状态</th><th/></tr></thead><tbody><tr v-for="a in config.appointments" :key="a.id"><td><strong>{{personName(a.employeeId)}}</strong><small class="mono">{{a.employeeId}}</small><small>{{allPeople.get(a.employeeId)?.dingLinked?'已绑定企业钉钉':'企业钉钉绑定待核验'}}</small></td><td>{{positionName(a.positionId)}}<small>{{a.duty==='PRIMARY'?'主处理':'备岗'}}</small></td><td>{{formatDate(a.validFrom)}}<small>至 {{formatDate(a.validTo)}}</small></td><td>{{a.enabled?'启用':'停用'}}</td><td><button v-if="!inspecting" class="icon-button" :aria-label="`编辑${personName(a.employeeId)}任职`" title="编辑任职" @click="edit(a.id)"><Pencil :size="16"/></button></td></tr></tbody></table>
      <table v-else-if="tab==='mappings'"><thead><tr><th>服务项</th><th>责任域 / 系统</th><th>主办 / 协办岗位</th><th>状态</th><th/></tr></thead><tbody><tr v-for="m in config.mappings" :key="m.serviceCode"><td><strong>{{serviceName(m.serviceCode)}}</strong><small class="mono">{{m.serviceCode}}</small></td><td>{{domainName(m.domainId)}}<small>{{systemName(m.systemId)}}</small></td><td>{{positionName(m.primaryPositionId)}}<small>{{m.collaboratingPositionIds.map(positionName).join('、')||'无协办'}}</small></td><td>{{m.enabled?'启用':'停用'}}</td><td><button v-if="!inspecting" class="icon-button" :aria-label="`编辑${serviceName(m.serviceCode)}映射`" title="编辑服务映射" @click="edit(m.serviceCode)"><Pencil :size="16"/></button></td></tr></tbody></table>
      <table v-else><thead><tr><th>变更依据</th><th>提交 / 复核</th><th>状态</th><th/></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><strong>{{item.reason}}</strong><small>基于版本 {{item.expectedVersion}} · {{formatDate(item.createdAt)}}</small></td><td>{{personName(item.proposedBy)}}<small>{{item.reviewedBy?personName(item.reviewedBy):'待复核'}}{{item.reviewReason?' · '+item.reviewReason:''}}</small></td><td>{{states[item.status]}}</td><td><button class="icon-button" title="查看完整配置" aria-label="查看完整配置" :disabled="busy||dirty" @click="inspect(item)"><Eye :size="17"/></button></td></tr></tbody></table>
      <p v-if="tab==='changes'?!items.length:structureTab&&!config[structureTab].length" class="structure-empty">暂无{{labels[tab]}}</p>
    </div>
    <section v-if="dirty&&!inspecting" class="detail-section publish-section" aria-label="配置发布">
      <h2>配置发布</h2><label>变更依据<textarea v-model="reason" maxlength="500" rows="2" required/></label><ContentBoundary v-model="safe"/>
      <div class="structure-tools"><button :disabled="busy||!safe||!reason.trim()||editing" @click="check"><Eye :size="16"/>预览分派</button><button class="primary" :disabled="busy||!safe||!preview||editing" @click="submit"><LoaderCircle v-if="busy" class="spin" :size="16"/><ChevronRight v-else :size="16"/>提交复核</button></div>
      <ul v-if="preview" class="routing-preview"><li v-for="r in preview" :key="r.serviceCode"><strong>{{serviceName(r.serviceCode)}}</strong> · {{r.enabled?groupName(r.groupId):'停用'}} · {{positionName(r.primaryPositionId)}}<p>{{r.candidates.map(p=>`${p.name}（${p.duty==='PRIMARY'?'主处理':'备岗'}）`).join('、')||'暂无有效任职人员'}}</p><p v-for="warning in r.warnings" :key="warning" class="danger-text">{{warningLabels[warning]??warning}}</p></li></ul>
    </section>
  </div>
</template>

<style scoped>
.structure-panel{min-width:0}.structure-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.structure-tabs{display:flex;gap:18px;overflow-x:auto;border-bottom:1px solid #dfe5e8;margin:16px 0 20px}.structure-tabs button{flex:none;min-height:44px;padding:10px 0;background:none;border:0;border-bottom:2px solid transparent;border-radius:0;color:#53636b}.structure-tabs button.active{border-bottom-color:#147e76;color:#146c65}.structure-table table{width:100%;table-layout:fixed}.structure-table td,.structure-table th{overflow-wrap:anywhere;vertical-align:top}.structure-table td:last-child,.structure-table th:last-child{width:52px}.structure-table small{display:block;margin-top:5px;color:#65747c;font-size:11px;overflow-wrap:anywhere}.structure-table strong{font-size:13px}.structure-toggle{display:flex;align-items:center;gap:8px;min-height:36px}.structure-toggle input{width:16px;height:16px;margin:0}.structure-search{display:flex;gap:8px;align-items:center}.structure-search input{min-width:0}.structure-search button{flex:none}.collaborators{border:0;padding:0;display:flex;gap:12px;flex-wrap:wrap}.collaborators legend{margin-bottom:8px;font-size:13px}.publish-section>label{display:grid;gap:8px;font-size:13px}.publish-section{display:grid;gap:16px;border-top:1px solid #dfe5e8;padding-top:24px;margin-top:24px}.routing-preview{list-style:none;padding:0;margin:0}.routing-preview li{padding:12px 0;border-bottom:1px solid #dfe5e8;font-size:13px;overflow-wrap:anywhere}.routing-preview p,.review-section p{font-size:12px;margin-top:8px;overflow-wrap:anywhere}.structure-empty{padding:24px;color:#65747c;font-size:13px}.success-banner{padding:12px 16px;border-left:3px solid #147e76;background:#edf8f4;color:#245c47;font-size:13px;margin-bottom:16px}@media(max-width:760px){.structure-tabs{gap:16px}.structure-table th,.structure-table td{padding:10px 5px;font-size:11px}.structure-table strong{font-size:12px}.structure-table td:last-child,.structure-table th:last-child{width:34px}.structure-table small{font-size:10px}.structure-tools button{min-height:36px}.form-grid{grid-template-columns:minmax(0,1fr)}}
</style>
