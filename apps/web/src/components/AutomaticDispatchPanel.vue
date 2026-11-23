<script setup lang="ts">
import {onMounted,ref} from 'vue';
import {Save,RefreshCw} from 'lucide-vue-next';
import {api,errorText} from '../api';
import {formatDate} from '../labels';
import ContentBoundary from './ContentBoundary.vue';
type Policy={code:string;name:string;published:boolean;version:number;enabled:boolean;primaryMinutes:number;backupMinutes:number;mapped:boolean};
type History={serviceCode:string;version:number;enabled:boolean;primaryMinutes:number;backupMinutes:number;actorName:string;reason:string;createdAt:string};
const items=ref<Policy[]>([]),history=ref<History[]>([]),selected=ref<Policy>(),reason=ref(''),safe=ref(false),busy=ref(false),error=ref('');
async function load(){
  try{const result=await api<{items:Policy[];history:History[]}>('/admin/routing-config/automatic');items.value=result.items;history.value=result.history;}
  catch(e){error.value=errorText(e);}
}
function edit(item:Policy){selected.value={...item};reason.value='';safe.value=false;}
async function save(){
  if(!selected.value||busy.value||!safe.value)return;
  busy.value=true;error.value='';
  try{const item=selected.value;await api('/admin/routing-config/automatic',{method:'POST',body:{serviceCode:item.code,
    expectedVersion:item.version,enabled:item.enabled,primaryMinutes:item.primaryMinutes,backupMinutes:item.backupMinutes,
    reason:reason.value,contentClass:'GENERAL'}});selected.value=undefined;await load();}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
onMounted(load);
</script>
<template>
  <section class="detail-section" aria-label="主备自动派单">
    <div class="section-heading"><h2>主备自动派单</h2><button class="icon-button" title="刷新自动派单规则" aria-label="刷新自动派单规则" :disabled="busy" @click="load"><RefreshCw :size="17"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div class="table-wrap"><table><thead><tr><th>服务</th><th>状态</th><th>主责接收时限</th><th>备用接收时限</th><th>操作</th></tr></thead>
      <tbody><tr v-for="item in items" :key="item.code"><td>{{item.name}}</td><td>{{item.enabled?'已启用':'未启用'}}</td><td>{{item.primaryMinutes}} 分钟</td><td>{{item.backupMinutes}} 分钟</td>
        <td><button :disabled="busy" @click="edit(item)">配置</button></td></tr></tbody></table></div>
    <form v-if="selected" class="action-form" @submit.prevent="save">
      <h3>{{selected.name}}</h3>
      <label class="check-label"><input v-model="selected.enabled" type="checkbox" :disabled="!selected.mapped&&!selected.enabled"/>启用主责优先、失败转备、主备失败升级</label>
      <div class="config-grid"><label>主责接收时限（自然分钟）<input v-model.number="selected.primaryMinutes" type="number" min="1" max="10080" required/></label>
        <label>备用接收时限（自然分钟）<input v-model.number="selected.backupMinutes" type="number" min="1" max="10080" required/></label></div>
      <label>变更依据<textarea v-model="reason" required maxlength="500" rows="2"/></label><ContentBoundary v-model="safe"/>
      <div class="form-footer"><button type="button" :disabled="busy" @click="selected=undefined">取消</button><button class="primary" :disabled="busy||!safe||!reason.trim()"><Save :size="16"/>保存并生效</button></div>
    </form>
    <details v-if="history.length"><summary>变更记录</summary><div class="table-wrap"><table><thead><tr><th>服务</th><th>版本</th><th>状态</th><th>操作人</th><th>依据</th><th>时间</th></tr></thead><tbody>
      <tr v-for="item in history" :key="`${item.serviceCode}:${item.version}`"><td>{{items.find(s=>s.code===item.serviceCode)?.name??item.serviceCode}}</td><td>{{item.version}}</td><td>{{item.enabled?'启用':'停用'}}</td><td>{{item.actorName}}</td><td>{{item.reason}}</td><td>{{formatDate(item.createdAt)}}</td></tr>
    </tbody></table></div></details>
  </section>
</template>
<style scoped>
.config-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.check-label{display:flex;align-items:center;gap:8px}.check-label input{width:auto}details{margin:16px 0}td{overflow-wrap:anywhere}@media(max-width:700px){.config-grid{grid-template-columns:1fr}table{min-width:600px}}
</style>
