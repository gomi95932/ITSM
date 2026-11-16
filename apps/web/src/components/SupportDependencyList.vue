<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next';
import type { SupportDependenciesView,SupportDependencyKind } from '@itsm/contracts';
defineProps<{value?:SupportDependenciesView;busy:boolean}>();
defineEmits<{refresh:[]}>();
const labels:Record<SupportDependencyKind,string>={TICKET:'未结工单',APPROVAL:'待完成审批或交付创建',FULFILLMENT:'未完成交付或未回收授权',
  KNOWLEDGE:'未归档知识',POSITION:'启用岗位',APPOINTMENT:'启用任职',CATALOG:'已发布服务目录',
  FALLBACK:'兜底组关系',ASSIGNMENT_POLICY:'启用分派策略'};
</script>

<template>
  <section class="dependency-check" aria-label="停用依赖检查">
    <div class="section-heading"><h3>停用依赖检查</h3><button type="button" class="icon-button" title="刷新停用检查" aria-label="刷新停用检查" :disabled="busy" @click="$emit('refresh')"><RefreshCw :size="16" :class="{spin:busy}"/></button></div>
    <p v-if="!value" class="muted">{{busy?'正在检查':'尚未取得检查结果'}}</p>
    <template v-else>
      <p :class="value.total?'danger-text':'muted'">{{value.total?`${value.total} 项阻塞依赖`:'无阻塞依赖'}}</p>
      <details v-for="item in value.items" :key="item.kind" open><summary>{{labels[item.kind]}} · {{item.total}}</summary>
        <ul><li v-for="reference in item.references" :key="reference.id"><strong>{{reference.name||reference.id}}</strong><span class="mono muted">{{reference.id}}</span></li></ul>
        <p v-if="item.hasMore" class="danger-text">此类仅显示前 100 项</p>
      </details>
      <p class="muted">成员与组内权限将在批准后撤销；恢复支持组不恢复原授权。</p>
    </template>
  </section>
</template>

<style scoped>
.dependency-check{min-width:0;border-left:3px solid #b8c8c1;padding:8px 0 8px 14px}.dependency-check h3{font-size:14px}.dependency-check p,.dependency-check summary{font-size:13px;line-height:1.6}.dependency-check details{margin:12px 0}.dependency-check ul{list-style:none;margin:8px 0;padding:0}.dependency-check li{padding:7px 0;border-bottom:1px solid #e0e6e8;overflow-wrap:anywhere}.dependency-check strong,.dependency-check span{display:block;font-size:12px}.dependency-check span{margin-top:4px}
</style>
