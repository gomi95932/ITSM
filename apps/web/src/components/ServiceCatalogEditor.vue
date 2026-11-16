<script setup lang="ts">
import { computed,ref } from 'vue';
import { Check,Pencil,Plus,Trash2,X } from 'lucide-vue-next';
import type { ServiceCatalogAdminItem,ServiceCatalogChange,ServicePositionMapping,ServiceStructure,ServiceStructureOptions,SessionUser } from '@itsm/contracts';
import ServiceCatalogSummary from './ServiceCatalogSummary.vue';

const props=defineProps<{items:ServiceCatalogAdminItem[];config:ServiceStructure;options:ServiceStructureOptions;user:SessionUser;
  change?:ServiceCatalogChange;busy:boolean;hasMore:boolean}>();
const emit=defineEmits<{save:[change:ServiceCatalogChange,mapping:ServicePositionMapping];cancel:[]}>();
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const editing=ref(false),error=ref(''),initialPublisherConfirmed=ref(false);
const blank=():ServiceCatalogChange=>({expectedVersion:0,code:'INC-',type:'INC',name:'',description:'',published:true,groupId:'',visibleGroups:[],sortOrder:0,
  fields:[],approval:null,maxValidityDays:null,initialPublisherId:null});
const form=ref<ServiceCatalogChange>(blank()),route=ref({domainId:'',systemId:'',primaryPositionId:'',collaboratingPositionIds:[] as string[]});
const approvalRoles=[{value:'MANAGER',label:'直线经理'},{value:'SYSTEM_OWNER',label:'系统负责人'},{value:'SECURITY_OWNER',label:'安全负责人'},
  {value:'RESOURCE_OWNER',label:'资源负责人'},{value:'LICENSE_OWNER',label:'许可负责人'},{value:'DIRECTORY_OWNER',label:'目录负责人'}] as const;
const positions=computed(()=>props.config.positions.filter(p=>p.domainId===route.value.domainId&&p.groupId===form.value.groupId));
function edit(item?:ServiceCatalogAdminItem){
  error.value='';initialPublisherConfirmed.value=false;
  form.value=item?{expectedVersion:item.formVersion,code:item.code,type:item.type as 'INC'|'REQ',name:item.name,description:item.description,
    published:item.published,groupId:item.groupId,visibleGroups:[...item.visibleGroups],sortOrder:item.sortOrder,fields:copy(item.fields),
    approval:copy(item.approval),maxValidityDays:item.maxValidityDays,initialPublisherId:null}:blank();
  if(props.change&&(!item||props.change.code===item.code)){form.value=copy(props.change);initialPublisherConfirmed.value=!!form.value.initialPublisherId;}
  if(form.value.type==='REQ'){
    form.value.approval??={templateId:'',steps:[{role:'MANAGER'}]};form.value.maxValidityDays??=30;
  }
  const mapping=props.config.mappings.find(m=>m.serviceCode===form.value.code);
  route.value=mapping?{domainId:mapping.domainId,systemId:mapping.systemId??'',primaryPositionId:mapping.primaryPositionId,collaboratingPositionIds:[...mapping.collaboratingPositionIds]}:
    {domainId:'',systemId:'',primaryPositionId:'',collaboratingPositionIds:[]};
  editing.value=true;
}
function changeType(){
  form.value.code=`${form.value.type}-`;
  form.value.approval=form.value.type==='REQ'?{templateId:'',steps:[{role:'MANAGER'}]}:null;
  form.value.maxValidityDays=form.value.type==='REQ'?30:null;
  form.value.initialPublisherId=null;initialPublisherConfirmed.value=false;
}
function save(){
  if(props.busy)return;
  if(props.change&&props.change.code!==form.value.code){error.value='当前草稿已有另一个目录变更，请先提交或放弃。';return;}
  if(!new RegExp(`^${form.value.type}-[A-Z0-9-]{1,36}$`).test(form.value.code)){error.value='服务编码须以对应类型开头，后接大写字母、数字或连字符。';return;}
  if(form.value.type==='REQ'&&form.value.expectedVersion===0){
    if(!initialPublisherConfirmed.value){error.value='请确认首位目录发布人任命。';return;}
    form.value.initialPublisherId=props.user.id;
  }
  emit('save',copy(form.value),{serviceCode:form.value.code,domainId:route.value.domainId,systemId:route.value.systemId||null,
    primaryPositionId:route.value.primaryPositionId,collaboratingPositionIds:[...route.value.collaboratingPositionIds].sort(),enabled:form.value.published});
  editing.value=false;
}
function setOptions(index:number,event:Event){
  const values=(event.target as HTMLInputElement).value.split('、').map(value=>value.trim()).filter(Boolean);
  if(values.length)form.value.fields[index].options=values;else delete form.value.fields[index].options;
}
</script>
<template>
  <section aria-label="服务目录维护" class="catalog-editor">
    <div class="section-heading"><h2>服务目录维护</h2><button class="primary" :disabled="busy||editing||!!change" @click="edit()"><Plus :size="16"/>新增服务项</button></div>
    <p v-if="hasMore" class="muted" role="status">当前展示前 500 项</p>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <section v-if="editing" class="detail-section" aria-label="编辑服务项">
      <div class="section-heading"><h2>{{form.expectedVersion?'编辑服务项':'新增服务项'}}</h2><button class="icon-button" title="取消服务项编辑" aria-label="取消服务项编辑" @click="editing=false"><X :size="18"/></button></div>
      <form class="action-form" @submit.prevent="save">
        <div class="form-grid">
          <label>服务类型<select v-model="form.type" :disabled="form.expectedVersion>0" @change="changeType"><option value="INC">故障服务</option><option value="REQ">标准请求</option></select></label>
          <label>服务编码<input v-model="form.code" :readonly="form.expectedVersion>0" required maxlength="40"/></label>
          <label>服务名称<input v-model="form.name" required maxlength="100"/></label>
          <label>展示顺序<input v-model.number="form.sortOrder" type="number" min="0" max="100000" step="1" required/></label>
          <label>服务描述<textarea v-model="form.description" required maxlength="500" rows="2"/></label>
          <label>默认支持组<select v-model="form.groupId" required><option value="">请选择</option><option v-for="g in options.groups" :key="g.id" :value="g.id">{{g.name}}</option></select></label>
          <label>责任域<select v-model="route.domainId" required><option value="">请选择</option><option v-for="d in config.domains" :key="d.id" :value="d.id">{{d.name}}{{d.enabled?'':'（停用）'}}</option></select></label>
          <label>关联业务系统<select v-model="route.systemId"><option value="">无关联</option><option v-for="s in config.systems.filter(s=>s.domainId===route.domainId)" :key="s.id" :value="s.id">{{s.name}}</option></select></label>
          <label>主办岗位<select v-model="route.primaryPositionId" required><option value="">请选择</option><option v-for="p in positions" :key="p.id" :value="p.id">{{p.name}}{{p.enabled?'':'（停用）'}}</option></select></label>
          <label class="structure-toggle"><input v-model="form.published" type="checkbox"/>发布服务项</label>
        </div>
        <fieldset><legend>可见支持组（未选择为全体员工）</legend><div class="choice-list"><label v-for="g in options.groups" :key="g.id" class="structure-toggle"><input v-model="form.visibleGroups" type="checkbox" :value="g.id"/>{{g.name}}</label></div></fieldset>
        <fieldset><legend>协办岗位</legend><div class="choice-list"><label v-for="p in config.positions.filter(p=>p.id!==route.primaryPositionId)" :key="p.id" class="structure-toggle"><input v-model="route.collaboratingPositionIds" type="checkbox" :value="p.id"/>{{p.name}}</label></div></fieldset>
        <fieldset><legend>受控字段</legend>
          <div v-for="(field,index) in form.fields" :key="index" class="field-row">
            <label>字段编码<input v-model="field.key" required maxlength="40"/></label><label>字段名称<input v-model="field.label" required maxlength="80"/></label>
            <label>选项（顿号分隔）<input :value="field.options?.join('、')??''" @input="setOptions(index,$event)"/></label>
            <label class="structure-toggle"><input v-model="field.required" type="checkbox"/>必填</label>
            <button type="button" class="icon-button" :aria-label="`移除字段${index+1}`" title="移除字段" @click="form.fields.splice(index,1)"><Trash2 :size="16"/></button>
          </div>
          <button type="button" :disabled="form.fields.length>=30" @click="form.fields.push({key:'',label:'',required:false})"><Plus :size="16"/>新增字段</button>
        </fieldset>
        <fieldset v-if="form.type==='REQ'"><legend>审批策略</legend>
          <div class="form-grid"><label>OA 审批模板<input v-model="form.approval!.templateId" required maxlength="256"/></label><label>最大有效天数<input v-model.number="form.maxValidityDays" type="number" min="1" max="3650" step="1" required/></label></div>
          <div v-for="(step,index) in form.approval!.steps" :key="index" class="approval-row">
            <label>审批职责<select v-model="step.role" @change="delete step.approverId"><option v-for="r in approvalRoles" :key="r.value" :value="r.value">{{r.label}}</option></select></label>
            <label v-if="step.role!=='MANAGER'">审批人员 ID<input v-model="step.approverId" required maxlength="100"/></label>
            <button type="button" class="icon-button" :disabled="form.approval!.steps.length<=1" :aria-label="`移除审批步骤${index+1}`" title="移除审批步骤" @click="form.approval!.steps.splice(index,1)"><Trash2 :size="16"/></button>
          </div>
          <button type="button" :disabled="form.approval!.steps.length>=5" @click="form.approval!.steps.push({role:'MANAGER'})"><Plus :size="16"/>新增审批步骤</button>
          <label v-if="form.expectedVersion===0" class="structure-toggle"><input v-model="initialPublisherConfirmed" type="checkbox" required/>任命 {{user.name}}（{{user.id}}）为首位目录发布人</label>
        </fieldset>
        <div class="form-footer"><button class="primary" :disabled="busy"><Check :size="16"/>确认目录草稿</button></div>
      </form>
    </section>
    <section v-if="change" aria-label="待提交目录草稿"><ServiceCatalogSummary :change="change"/><div class="draft-tools"><button :disabled="busy||editing" @click="edit(items.find(item=>item.code===change.code))"><Pencil :size="16"/>编辑目录草稿</button><button :disabled="busy" @click="emit('cancel')"><X :size="16"/>放弃目录草稿</button></div></section>
    <div class="table-wrap"><table><thead><tr><th>服务项</th><th>类型 / 版本</th><th>状态</th><th/></tr></thead><tbody>
      <tr v-for="item in items" :key="item.code"><td><strong>{{item.name}}</strong><small>{{item.code}}</small></td><td>{{item.type}} · {{item.formVersion}}</td><td>{{item.published?'已发布':'停用'}}</td><td><button v-if="item.canPropose" class="icon-button" :aria-label="`编辑目录${item.name}`" title="编辑目录" :disabled="busy||editing||!!change" @click="edit(item)"><Pencil :size="16"/></button></td></tr>
    </tbody></table></div>
  </section>
</template>
<style scoped>
.catalog-editor{min-width:0}.catalog-editor h2{font-size:16px}.catalog-editor fieldset{min-width:0;margin:0;padding:16px 0;border:0;border-top:1px solid #dfe5e8}.catalog-editor legend{font-size:13px;padding:0 8px 0 0}.choice-list,.draft-tools{display:flex;gap:12px;flex-wrap:wrap}.draft-tools{margin:12px 0 24px}.structure-toggle{display:flex;align-items:center;gap:8px;min-height:36px;font-size:13px}.structure-toggle input{width:16px;height:16px;margin:0;flex:none}.field-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.5fr) 70px 36px;gap:12px;align-items:end;margin-bottom:16px}.approval-row{display:flex;gap:12px;align-items:end;margin:16px 0}.field-row label,.approval-row label{display:grid;gap:8px;font-size:13px;min-width:0}.field-row .structure-toggle{display:flex}.approval-row label{flex:1}.catalog-editor table{table-layout:fixed;width:100%}.catalog-editor td,.catalog-editor th{overflow-wrap:anywhere}.catalog-editor td:last-child{width:42px}.catalog-editor small{display:block;font-size:11px;margin-top:6px;color:#65747c}@media(max-width:760px){.field-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.approval-row{flex-wrap:wrap}.form-grid{grid-template-columns:minmax(0,1fr)}.catalog-editor td,.catalog-editor th{font-size:11px;padding:10px 5px}}
</style>
