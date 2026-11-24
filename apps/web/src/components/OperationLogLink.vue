<script setup lang="ts">
import {inject} from 'vue';
import {ScrollText} from 'lucide-vue-next';
import type {OperationLogModule} from '@itsm/contracts';
import {canReadOperationLogs,operationLogNavigation} from '../operation-logs';
defineProps<{module:OperationLogModule;object?:string;disabled?:boolean}>();
const open=inject(operationLogNavigation),allowed=inject(canReadOperationLogs,()=>false);
</script>
<template><button v-if="open&&allowed()" type="button" class="text-button log-link" :disabled="disabled" @click="open({module,object})"><ScrollText :size="16"/>查看相关日志</button></template>
<style scoped>.log-link{display:inline-flex;align-items:center;gap:6px;margin:12px 0;max-width:100%}</style>
