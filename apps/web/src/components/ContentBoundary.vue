<script setup lang="ts">
import { onMounted,ref } from 'vue';
import { api } from '../api';
defineProps<{modelValue:boolean}>();
const emit=defineEmits<{'update:modelValue':[value:boolean]}>();
const contact=ref('请通过公司现有安全应急电话或线下联系信息安全负责人，请勿在此提交证据。');
onMounted(async()=>{
  try { contact.value=(await api<{securityContact:string}>('/intake-policy')).securityContact; }
  catch { /* Keep the offline fallback available when configuration cannot be loaded. */ }
});
</script>
<template>
  <div class="content-boundary">
    <label class="checkbox-label"><input type="checkbox" required :checked="modelValue" @change="emit('update:modelValue',($event.target as HTMLInputElement).checked)"/> 本次内容不含密码、密钥及安全事件证据</label>
    <details><summary>安全事件联络</summary><p class="muted">{{contact}}</p></details>
  </div>
</template>
<style scoped>
.content-boundary{margin:16px 0;min-width:0;overflow-wrap:anywhere}
details{margin-top:10px;font-size:12px;line-height:1.6}
summary{cursor:pointer;color:#117965}
details p{margin-top:8px;white-space:pre-wrap}
</style>
