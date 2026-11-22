<script setup lang="ts">
import {computed,onMounted,ref,watch} from 'vue';
import {Check,Plus,RefreshCw,Send,Trash2,X} from 'lucide-vue-next';
import {EMPTY_OPERATIONS,DEFAULT_PRIORITY_POLICY,type OperationsConfig,type SessionUser} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import ContentBoundary from './ContentBoundary.vue';
const props=defineProps<{user:SessionUser}>();
type Option={id:string;name:string};
type Proposal={id:string;config:OperationsConfig;reason:string;status:string;version:number;proposed_by:string};
type Section='sites'|'employeeSites'|'groupSites'|'positionSites'|'serviceSites'|'siteRoutes'|'slaTemplates'|'serviceSlas';
const config=ref<OperationsConfig>(structuredClone(EMPTY_OPERATIONS)),version=ref(1),proposals=ref<Proposal[]>([]);
const groups=ref<Option[]>([]),positions=ref<Option[]>([]),people=ref<Option[]>([]),services=ref<Option[]>([]);
const tab=ref<Section>('sites'),busy=ref(false),error=ref(''),reason=ref(''),safe=ref(false),reviewReason=ref(''),reviewSafe=ref(false);
const requestId=ref(createRequestKey());
watch([config,reason],()=>{requestId.value=createRequestKey();},{deep:true});
const labels:Record<Section,string>={sites:'厂区',employeeSites:'人员范围',groupSites:'支持组范围',positionSites:'岗位范围',serviceSites:'服务范围',siteRoutes:'厂区派单',slaTemplates:'SLA 模板',serviceSlas:'服务 SLA'};
const sections=Object.keys(labels) as Section[];
const bindingField:Partial<Record<Section,string>>={employeeSites:'employeeId',groupSites:'groupId',positionSites:'positionId',serviceSites:'serviceCode',serviceSlas:'serviceCode'};
const enabledSites=computed(()=>config.value.sites.filter(s=>s.enabled));
const pending=computed(()=>proposals.value.filter(p=>p.status==='PENDING'));
function options(section:Section):Option[]{return section==='employeeSites'?people.value:section==='groupSites'?groups.value:section==='positionSites'?positions.value:services.value;}
function rows(section:Section):Record<string,unknown>[] {return config.value[section] as unknown as Record<string,unknown>[];}
function set(row:Record<string,unknown>,key:string,event:Event){row[key]=(event.target as HTMLInputElement).value;safe.value=false;}
function add(){const first=enabledSites.value[0]?.id??'';
  const defaults:Record<Section,unknown>={sites:{id:createRequestKey(),name:'',enabled:true},employeeSites:{employeeId:'',homeSiteId:first,siteIds:first?[first]:[]},
    groupSites:{groupId:'',siteIds:first?[first]:[]},positionSites:{positionId:'',siteIds:first?[first]:[]},serviceSites:{serviceCode:'',siteIds:first?[first]:[]},
    siteRoutes:{serviceCode:'',siteId:first,positionId:''},slaTemplates:{id:createRequestKey(),name:'',enabled:true,targets:structuredClone(DEFAULT_PRIORITY_POLICY.targets)},serviceSlas:{serviceCode:'',templateId:''}};
  rows(tab.value).push(defaults[tab.value] as Record<string,unknown>);safe.value=false;
}
function toggleSite(row:Record<string,unknown>,site:string,event:Event){const values=row.siteIds as string[];
  row.siteIds=(event.target as HTMLInputElement).checked?[...values,site]:values.filter(s=>s!==site);safe.value=false;}
function remove(index:number){rows(tab.value).splice(index,1);safe.value=false;}
async function load(){busy.value=true;error.value='';try{const r=await api<{current:{version:number;config:OperationsConfig};proposals:Proposal[];groups:Option[];positions:Option[];people:Option[];services:{code:string;name:string}[]}>('/admin/operations');
  version.value=r.current.version;config.value=structuredClone(r.current.config);proposals.value=r.proposals;groups.value=r.groups;positions.value=r.positions;people.value=r.people;
  services.value=r.services.map(s=>({id:s.code,name:s.name}));safe.value=false;
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function propose(){if(!safe.value||busy.value)return;busy.value=true;error.value='';try{
  await api('/admin/operations',{method:'POST',body:{id:requestId.value,expectedVersion:version.value,config:config.value,reason:reason.value,contentClass:'GENERAL'}});
  reason.value='';await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
async function review(p:Proposal,decision:'APPROVE'|'REJECT'){if(!reviewSafe.value||busy.value)return;busy.value=true;error.value='';try{
  await api(`/admin/operations/${p.id}/review`,{method:'POST',body:{expectedVersion:p.version,decision,reason:reviewReason.value,contentClass:'GENERAL'}});
  reviewReason.value='';reviewSafe.value=false;await load();
}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
onMounted(load);
</script>
<template>
  <section class="operations-panel"><div class="section-heading"><p class="muted">当前版本 {{version}}</p><button class="icon-button" title="刷新" aria-label="刷新" :disabled="busy" @click="load"><RefreshCw :size="18"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <nav class="section-tabs" aria-label="配置分类"><button v-for="s in sections" :key="s" :class="{selected:tab===s}" @click="tab=s">{{labels[s]}}</button></nav>
    <form @submit.prevent="propose"><fieldset :disabled="busy"><label class="check-row"><input v-model="config.siteEnforced" type="checkbox" @change="safe=false"/>启用厂区隔离</label>
      <div class="section-heading"><h2>{{labels[tab]}}</h2><button type="button" class="secondary" @click="add"><Plus :size="16"/>新增</button></div>
      <div v-if="tab==='sites'" class="rows"><div v-for="site in config.sites" :key="site.id" class="config-row"><label>标识<input v-model="site.id" required maxlength="100" @input="safe=false"/></label><label>名称<input v-model="site.name" required maxlength="100" @input="safe=false"/></label><label class="check-row"><input v-model="site.enabled" type="checkbox" @change="safe=false"/>启用</label></div></div>
      <div v-else-if="tab==='slaTemplates'" class="rows"><section v-for="tpl in config.slaTemplates" :key="tpl.id" class="template-row"><div class="config-row"><label>名称<input v-model="tpl.name" required maxlength="100" @input="safe=false"/></label><label class="check-row"><input v-model="tpl.enabled" type="checkbox" @change="safe=false"/>启用</label></div><table><thead><tr><th>优先级</th><th>响应 / 分钟</th><th>解决或交付 / 分钟</th></tr></thead><tbody><tr v-for="p in (['P1','P2','P3','P4'] as const)" :key="p"><th>{{p}}</th><td><input v-model.number="tpl.targets[p].response" aria-label="响应分钟" type="number" min="1" required @input="safe=false"/></td><td><input v-model.number="tpl.targets[p].resolution" aria-label="解决分钟" type="number" min="1" required @input="safe=false"/></td></tr></tbody></table></section></div>
      <div v-else class="rows"><div v-for="(row,index) in rows(tab)" :key="`${tab}-${index}`" class="config-row">
        <label v-if="bindingField[tab]">{{tab==='employeeSites'?'人员':tab==='groupSites'?'支持组':tab==='positionSites'?'岗位':'服务'}}<select :value="row[bindingField[tab]!]" required @change="set(row,bindingField[tab]!,$event)"><option value="">请选择</option><option v-for="o in options(tab)" :key="o.id" :value="o.id">{{o.name}} · {{o.id}}</option></select></label>
        <template v-if="tab==='siteRoutes'"><label>服务<select :value="row.serviceCode" required @change="set(row,'serviceCode',$event)"><option value="">请选择</option><option v-for="s in services" :key="s.id" :value="s.id">{{s.name}}</option></select></label><label>厂区<select :value="row.siteId" required @change="set(row,'siteId',$event)"><option v-for="s in enabledSites" :key="s.id" :value="s.id">{{s.name}}</option></select></label><label>主责岗位<select :value="row.positionId" required @change="set(row,'positionId',$event)"><option value="">请选择</option><option v-for="p in positions" :key="p.id" :value="p.id">{{p.name}}</option></select></label></template>
        <label v-if="tab==='employeeSites'">归属厂区<select :value="row.homeSiteId" required @change="set(row,'homeSiteId',$event)"><option v-for="s in enabledSites" :key="s.id" :value="s.id">{{s.name}}</option></select></label>
        <label v-if="tab==='serviceSlas'">SLA 模板<select :value="row.templateId" required @change="set(row,'templateId',$event)"><option value="">请选择</option><option v-for="s in config.slaTemplates.filter(t=>t.enabled)" :key="s.id" :value="s.id">{{s.name}}</option></select></label>
        <div v-if="Array.isArray(row.siteIds)" class="site-options"><label v-for="s in enabledSites" :key="s.id" class="check-row"><input type="checkbox" :checked="(row.siteIds as string[]).includes(s.id)" @change="toggleSite(row,s.id,$event)"/>{{s.name}}</label></div>
        <button type="button" class="icon-button" title="移除配置行" aria-label="移除配置行" @click="remove(index)"><Trash2 :size="16"/></button>
      </div></div>
      <label>变更原因<textarea v-model="reason" required maxlength="500" rows="2" @input="safe=false"/></label><ContentBoundary v-model="safe"/><button class="primary" :disabled="!safe||busy"><Send :size="16"/>提交独立复核</button>
    </fieldset></form>
    <section v-if="pending.length" class="review-section"><h2>待复核提案</h2><label>复核意见<textarea v-model="reviewReason" maxlength="500" rows="2" @input="reviewSafe=false"/></label><ContentBoundary v-model="reviewSafe"/>
      <article v-for="p in pending" :key="p.id" class="proposal-row"><p>{{p.reason}} · {{p.proposed_by}}</p><details><summary>查看变更内容</summary><pre>{{JSON.stringify(p.config,null,2)}}</pre></details><div v-if="p.proposed_by!==props.user.id" class="actions"><button class="secondary" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review(p,'REJECT')"><X :size="16"/>拒绝</button><button class="primary" :disabled="busy||!reviewSafe||!reviewReason.trim()" @click="review(p,'APPROVE')"><Check :size="16"/>批准</button></div></article>
    </section>
  </section>
</template>
<style scoped>
fieldset{border:0;padding:0;min-width:0}.section-heading,.actions,.config-row{display:flex;align-items:end;gap:12px;flex-wrap:wrap}.section-heading{justify-content:space-between;align-items:center}.section-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #d9e0e8;padding-bottom:12px;margin:16px 0}.section-tabs button{background:transparent;border:0;padding:8px 12px}.section-tabs .selected{background:#e7f4ed;color:#17613f}.rows{margin-bottom:24px}.config-row,.template-row,.proposal-row{padding:16px 0;border-bottom:1px solid #e0e5eb}.config-row>label{flex:1;min-width:170px;max-width:100%}.check-row{display:flex;align-items:center;gap:8px}.check-row input{width:auto}.site-options{display:flex;gap:12px;flex-wrap:wrap;flex:2}.review-section{margin-top:32px}table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{text-align:left;padding:8px;overflow-wrap:anywhere}td input{width:100%;min-width:0;max-width:180px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}.operations-panel{max-width:1100px;min-width:0}select{max-width:100%}
</style>
