<script setup lang="ts">
import type { ServiceCatalogChange } from '@itsm/contracts';
defineProps<{change:ServiceCatalogChange}>();
const roles:Record<string,string>={MANAGER:'直线经理',SYSTEM_OWNER:'系统负责人',SECURITY_OWNER:'安全负责人',RESOURCE_OWNER:'资源负责人',LICENSE_OWNER:'许可负责人',DIRECTORY_OWNER:'目录负责人'};
</script>
<template>
  <section class="catalog-summary" aria-label="服务目录变更明细">
    <h3>{{change.name}} · {{change.code}}</h3>
    <dl><dt>类型 / 状态</dt><dd>{{change.type==='INC'?'故障服务':'标准请求'}} · {{change.published?'发布':'停用'}} · 表单版本 {{change.expectedVersion}} → {{change.expectedVersion+1}}</dd>
      <dt>描述</dt><dd>{{change.description}}</dd><dt>默认组 / 展示顺序</dt><dd>{{change.groupId}} · {{change.sortOrder}}</dd>
      <dt>可见支持组</dt><dd>{{change.visibleGroups.join('、')||'全体员工'}}</dd>
      <dt>受控字段</dt><dd><ul><li v-for="field in change.fields" :key="field.key">{{field.label}}（{{field.key}}）· {{field.required?'必填':'选填'}}{{field.options?' · '+field.options.join('、'):''}}</li></ul><span v-if="!change.fields.length">无附加字段</span></dd>
      <template v-if="change.type==='REQ'"><dt>审批模板 / 有效期</dt><dd>{{change.approval?.templateId}} · {{change.maxValidityDays}} 天</dd>
        <dt>审批步骤</dt><dd><ol><li v-for="(step,index) in change.approval?.steps" :key="index">{{roles[step.role]}} · {{step.approverId||'申请人直线经理'}}</li></ol></dd>
        <dt v-if="change.initialPublisherId">首位发布人任命</dt><dd v-if="change.initialPublisherId">{{change.initialPublisherId}}</dd>
      </template>
    </dl>
  </section>
</template>
<style scoped>
.catalog-summary{padding:16px 0;border-block:1px solid #dfe5e8;overflow-wrap:anywhere}.catalog-summary h3{font-size:14px;margin:0 0 14px}.catalog-summary dl{display:grid;grid-template-columns:140px minmax(0,1fr);gap:10px;font-size:12px}.catalog-summary dt{color:#65747c}.catalog-summary dd{margin:0}.catalog-summary ul,.catalog-summary ol{margin:0;padding-left:18px}@media(max-width:760px){.catalog-summary dl{grid-template-columns:minmax(0,1fr);gap:6px}.catalog-summary dd{margin-bottom:8px}}
</style>
