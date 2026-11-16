<script setup lang="ts">
import { computed,ref } from 'vue';
import { Check,X } from 'lucide-vue-next';
import { addCompanyServiceStructureTemplate,COMPANY_SERVICE_STRUCTURE_TEMPLATE } from '@itsm/contracts';
import type { ServiceStructure,ServiceStructureOptions } from '@itsm/contracts';

const props=defineProps<{config:ServiceStructure;groups:ServiceStructureOptions['groups']}>();
const emit=defineEmits<{save:[config:ServiceStructure];cancel:[]}>();
const selections=ref(COMPANY_SERVICE_STRUCTURE_TEMPLATE.map(row=>({domainId:row.id,selected:true,groupId:''})));
const choices=computed(()=>selections.value.filter(row=>row.selected));
const ready=computed(()=>choices.value.length>0&&choices.value.every(row=>row.groupId));
const result=computed(()=>ready.value?addCompanyServiceStructureTemplate(props.config,props.groups,choices.value):undefined);
const kindLabels={domains:'责任域',systems:'业务系统',positions:'岗位'};
const conflictLabels={SELECTION:'模板选择冲突',GROUP:'支持组不可用',NAME:'已有同名记录，需先核对编码',DOMAIN:'已有编码归属其他责任域'};
function save(){if(result.value&&!result.value.conflicts.length&&result.value.added.length)emit('save',result.value.config);}
</script>

<template>
  <section class="detail-section template-section" aria-label="初始组织模板">
    <div class="section-heading"><h2>初始组织模板</h2><button class="icon-button" aria-label="关闭初始组织模板" title="关闭初始组织模板" @click="emit('cancel')"><X :size="18"/></button></div>
    <form class="action-form" @submit.prevent="save">
      <div class="form-grid">
        <fieldset v-for="(template,index) in COMPANY_SERVICE_STRUCTURE_TEMPLATE" :key="template.id" class="template-choice">
          <legend><label class="template-toggle"><input v-model="selections[index].selected" type="checkbox"/>{{template.name}}</label></legend>
          <label>支持组 · {{template.name}}<select v-model="selections[index].groupId" :required="selections[index].selected" :disabled="!selections[index].selected"><option value="">请选择</option><option v-for="group in groups" :key="group.id" :value="group.id">{{group.name}}</option></select></label>
          <p class="muted">{{template.systems.length}} 个业务系统 · {{template.positions.length}} 个岗位</p>
        </fieldset>
      </div>
      <template v-if="result">
        <ul v-if="result.conflicts.length" class="template-conflicts" role="alert"><li v-for="(conflict,index) in result.conflicts" :key="index">{{conflict.name}}：{{conflictLabels[conflict.reason]}}</li></ul>
        <template v-else>
          <p role="status">待新增 {{result.added.length}} 项 · 保留已有 {{result.retained.length}} 项 · 新增项均为停用状态</p>
          <div v-if="result.added.length" class="table-wrap template-table"><table><thead><tr><th>类别</th><th>名称</th><th>状态</th></tr></thead><tbody><tr v-for="entry in result.added" :key="`${entry.kind}-${entry.id}`"><td>{{kindLabels[entry.kind]}}</td><td>{{entry.name}}</td><td>停用</td></tr></tbody></table></div>
          <p v-else class="muted">所选模板已存在，无新增配置</p>
          <p class="muted">人员任命 0 项 · 服务路由 0 项 · 服务发布 0 项</p>
        </template>
      </template>
      <div class="form-footer"><button type="button" @click="emit('cancel')">取消</button><button class="primary" :disabled="!result||!!result.conflicts.length||!result.added.length"><Check :size="16"/>加入配置草稿</button></div>
    </form>
  </section>
</template>

<style scoped>
.template-section{border-bottom:1px solid #dfe5e8;margin-bottom:20px;padding-bottom:20px}.template-choice{min-width:0;border:0;padding:0;margin:0}.template-choice>label{display:grid;gap:8px;font-size:13px}.template-choice legend{padding:0;margin-bottom:12px;font-size:14px}.template-toggle{display:flex;align-items:center;gap:8px}.template-toggle input{width:16px;height:16px;margin:0}.template-choice p{font-size:12px;margin-top:8px}.template-conflicts{color:#a02c35;padding-left:20px;overflow-wrap:anywhere}.template-table table{width:100%;table-layout:fixed}.template-table th,.template-table td{overflow-wrap:anywhere}.template-table th:first-child{width:80px}.template-table th:last-child{width:60px}.template-section p{overflow-wrap:anywhere}@media(max-width:760px){.form-grid{grid-template-columns:minmax(0,1fr)}.template-table th,.template-table td{padding:10px 5px;font-size:12px}}
</style>
