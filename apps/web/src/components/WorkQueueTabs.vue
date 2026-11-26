<script setup lang="ts">
import { ArrowDownToLine, ArrowUpFromLine, History, Inbox, ListFilter, UserRound } from 'lucide-vue-next';
import type { WorkQueue, WorkQueueCounts } from '@itsm/contracts';

defineProps<{ modelValue: WorkQueue; counts: WorkQueueCounts; loading: boolean }>();
defineEmits<{ 'update:modelValue': [value: WorkQueue] }>();
const queues = [
  { value: 'all', label: '全部可见', icon: ListFilter },
  { value: 'assigned', label: '我负责的在办工单', icon: UserRound },
  { value: 'handled', label: '我处理过的工单', icon: History },
  { value: 'incoming', label: '待我接收', icon: ArrowDownToLine },
  { value: 'outgoing', label: '待对方接收', icon: ArrowUpFromLine },
  { value: 'unassigned', label: '组内未接单', icon: Inbox },
  { value: 'triage', label: '待我分派', icon: Inbox },
] as const;
const compactCount = (value: number) => value > 9999 ? `${Math.floor(value / 10000)}万+` : String(value);
</script>

<template>
  <div class="work-queues" role="group" aria-label="工作队列" :aria-busy="loading">
    <button v-for="queue in queues" :key="queue.value" type="button"
      :aria-label="queue.label" :aria-pressed="modelValue === queue.value"
      :class="{ selected: modelValue === queue.value }"
      @click="$emit('update:modelValue', queue.value)">
      <component :is="queue.icon" :size="17" aria-hidden="true" />
      <span class="queue-label">{{ queue.label }}</span>
      <span class="queue-count" :title="`${counts[queue.value]} 条`">{{ compactCount(counts[queue.value]) }}</span>
    </button>
  </div>
</template>

<style scoped>
.work-queues{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:20px}
.work-queues button{display:grid;grid-template-columns:17px minmax(0,1fr) auto;gap:8px;min-height:52px;padding:10px;border:1px solid #dce2e6;background:#fff;text-align:left;font-size:12px}
.work-queues button:hover{border-color:#86b7a8;background:#f3f8f6}
.work-queues button.selected{border-color:#117965;background:#eaf5f0;color:#0c6d5a;box-shadow:inset 0 -2px #117965}
.queue-label{overflow-wrap:anywhere;line-height:1.5}
.queue-count{min-width:24px;max-width:64px;text-align:center;font-size:11px;font-variant-numeric:tabular-nums;border-radius:4px;padding:2px 4px;background:#edf2f3;overflow-wrap:anywhere}
@media(max-width:1100px){.work-queues{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:760px){.work-queues{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.work-queues button{min-height:58px;padding:8px;gap:6px}}
</style>
