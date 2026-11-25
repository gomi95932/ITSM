<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {Check,LoaderCircle,RefreshCw,Search,X} from 'lucide-vue-next';
import type {MemberPrivilege,MemberPrivilegesInput,MemberPrivilegesView} from '@itsm/contracts';
import {api,errorText} from '../api';
import {createRequestKey} from '../request-key';
import ContentBoundary from './ContentBoundary.vue';
import OperationLogLink from './OperationLogLink.vue';

const props=defineProps<{groupId:string;employeeId:string}>();
const emit=defineEmits<{saved:[];close:[]}>();
const labels:Record<MemberPrivilege,string>={P1_REVIEW:'P1 复核',KNOWLEDGE_EDIT:'知识编辑',KNOWLEDGE_REVIEW:'知识审校'};
const value=ref<MemberPrivilegesView>(),privileges=ref<MemberPrivilege[]>([]),codes=ref<string[]>([]);
const loading=ref(true),busy=ref(false),error=ref(''),reason=ref(''),safe=ref(false),search=ref(''),key=ref(createRequestKey());
const dialog=ref<HTMLElement>();let alive=true;let previousFocus:HTMLElement|null=null;
const endpoint=computed(()=>`/admin/support-structure/groups/${encodeURIComponent(props.groupId)}/members/${encodeURIComponent(props.employeeId)}/privileges`);
const services=computed(()=>value.value?.catalogServices.filter(s=>`${s.code} ${s.name}`.toLowerCase().includes(search.value.trim().toLowerCase()))??[]);
const changed=computed(()=>!!value.value&&(JSON.stringify([...privileges.value].sort())!==JSON.stringify([...value.value.privileges].sort())
  ||JSON.stringify([...codes.value].sort())!==JSON.stringify([...value.value.catalogServiceCodes].sort())));
watch([privileges,codes,reason],()=>{safe.value=false;key.value=createRequestKey();},{deep:true});
async function load(){
  loading.value=true;error.value='';
  try{
    const result=await api<MemberPrivilegesView>(endpoint.value);if(!alive)return;
    value.value=result;privileges.value=[...result.privileges];codes.value=[...result.catalogServiceCodes];reason.value='';safe.value=false;
  }catch(e){if(alive)error.value=errorText(e);}
  finally{if(alive)loading.value=false;}
}
async function save(){
  if(!value.value||busy.value||!changed.value||!safe.value||!reason.value.trim())return;
  const input:MemberPrivilegesInput={id:key.value,expectedGroupVersion:value.value.group.version,privileges:privileges.value,
    catalogServiceCodes:codes.value,reason:reason.value,contentClass:'GENERAL'};
  busy.value=true;error.value='';
  try{await api(endpoint.value,{method:'POST',body:input});if(alive)emit('saved');}
  catch(e){if(alive)error.value=errorText(e);}finally{if(alive)busy.value=false;}
}
function keyboard(event:KeyboardEvent){
  if(event.key==='Escape'){event.preventDefault();if(!busy.value)emit('close');}
  if(event.key!=='Tab'||!dialog.value)return;
  const nodes=Array.from(dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(e=>e.getClientRects().length);
  const first=nodes[0],last=nodes.at(-1);
  if(event.shiftKey&&(document.activeElement===first||!nodes.includes(document.activeElement as HTMLElement))){event.preventDefault();last?.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!nodes.includes(document.activeElement as HTMLElement))){event.preventDefault();first?.focus();}
}
onMounted(async()=>{previousFocus=document.activeElement as HTMLElement;await nextTick();dialog.value?.focus();await load();});
onBeforeUnmount(()=>{alive=false;previousFocus?.focus();});
</script>

<template>
  <div class="modal-backdrop" @keydown="keyboard"><section ref="dialog" class="modal member-permissions" role="dialog" aria-modal="true" aria-labelledby="member-permissions-title" tabindex="-1">
    <div class="section-heading"><h2 id="member-permissions-title">成员权限</h2><button class="icon-button" title="关闭成员权限" aria-label="关闭成员权限" :disabled="busy" @click="emit('close')"><X :size="18"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <div v-if="loading" class="empty-state" role="status"><LoaderCircle class="spin" :size="24"/>正在读取权限</div>
    <template v-else-if="value">
      <p class="member-heading"><strong>{{value.member.name}}</strong> · {{value.group.name}}</p>
      <p v-if="!value.member.active||!value.group.enabled" class="error-banner">员工或支持组已停用，无法配置权限。</p>
      <form @submit.prevent="save"><fieldset :disabled="busy||!value.member.active||!value.group.enabled">
        <legend>组内附加权限</legend>
        <label v-for="(label,code) in labels" :key="code" class="checkbox-label permission-option"><input v-model="privileges" type="checkbox" :value="code"/>{{label}}</label>
        <p class="muted permission-policy">P1 复核人不得复核本人提交或本人调整的工单；知识审校人不得审校本人编写的文章。</p>
        <section class="publisher-section" aria-label="服务目录发布权限"><h3>服务目录发布权限</h3>
          <label class="search-label"><Search :size="16"/><input v-model="search" aria-label="搜索可授权服务" placeholder="搜索服务名称或编码"/></label>
          <div class="publisher-list"><label v-for="service in services" :key="service.code" class="checkbox-label permission-option"><input v-model="codes" type="checkbox" :value="service.code"/><span>{{service.name}}<small>{{service.code}} · {{service.published?'已发布':'未发布'}}</small></span></label></div>
          <p v-if="!services.length" class="muted">{{value.catalogServices.length?'没有匹配的服务':'此支持组暂无申请类服务'}}</p>
          <p class="muted">已选择 {{codes.length}} 项</p>
        </section>
        <label class="reason-label">变更依据<textarea v-model="reason" required rows="3" maxlength="500"/></label>
        <ContentBoundary v-model="safe"/>
        <div class="form-footer"><button type="button" class="icon-button" title="重新读取权限" aria-label="重新读取权限" @click="load"><RefreshCw :size="17"/></button><button class="primary" :disabled="!changed||!safe||!reason.trim()"><LoaderCircle v-if="busy" class="spin" :size="17"/><Check v-else :size="17"/>保存并生效</button></div>
      </fieldset></form>
      <OperationLogLink module="roles" :object="groupId" :disabled="busy"/>
    </template>
    <button v-else class="secondary" @click="load"><RefreshCw :size="17"/>重新读取权限</button>
  </section></div>
</template>

<style scoped>
.member-permissions{width:600px;max-width:calc(100vw - 32px);max-height:calc(100dvh - 32px);overflow:auto;outline:none}.member-permissions fieldset{border:0;margin:18px 0 0;padding:0;min-width:0}.member-permissions legend,.member-permissions h3{font-size:14px;font-weight:600;margin:0 0 12px}.member-heading,.permission-policy,.publisher-section p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}.permission-option{display:flex;align-items:center;gap:10px;padding:9px 0;font-size:14px}.permission-option input{flex:none;width:16px;height:16px;margin:0}.permission-option span{min-width:0;overflow-wrap:anywhere}.permission-option small{display:block;font-size:12px;color:#607079;margin-top:4px}.publisher-section{border-top:1px solid #dfe5e8;margin:18px 0;padding-top:18px}.publisher-list{max-height:210px;overflow:auto;margin:8px 0}.search-label{display:flex;align-items:center;gap:8px}.search-label input{min-width:0;width:100%}.reason-label{display:grid;gap:8px}.form-footer{gap:12px}.permission-policy{margin:8px 0}.member-permissions button{flex-shrink:0}
</style>
