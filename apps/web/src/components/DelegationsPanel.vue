<script setup lang="ts">
import {onMounted,ref,watch} from 'vue';
import {Check,LoaderCircle,RefreshCw,X} from 'lucide-vue-next';
import type {DelegationView,SessionUser} from '@itsm/contracts';
import {api,errorText} from '../api';
import {formatDate} from '../labels';
const props=defineProps<{user:SessionUser}>();
const grants=ref<DelegationView[]>([]),candidates=ref<{id:string;name:string}[]>([]),delegate=ref(''),hours=ref(24),consent=ref(false),busy=ref(false),error=ref(''),grantId=ref(crypto.randomUUID());
let expiresAt='';
watch([delegate,hours],()=>{grantId.value=crypto.randomUUID();expiresAt='';consent.value=false;});
async function load(){error.value='';try{const [list,people]=await Promise.all([api<{items:DelegationView[]}>('/delegations'),api<{items:{id:string;name:string}[]}>('/delegations/candidates')]);grants.value=list.items;candidates.value=people.items;}catch(e){error.value=errorText(e);}}
async function grant(){
  if(!delegate.value||!consent.value||busy.value)return;busy.value=true;error.value='';
  try{expiresAt||=new Date(Date.now()+hours.value*3600000).toISOString();await api('/delegations',{method:'POST',body:{id:grantId.value,delegateId:delegate.value,expiresAt,consent:true}});delegate.value='';consent.value=false;await load();}
  catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function revoke(id:string){if(busy.value)return;busy.value=true;error.value='';try{await api(`/delegations/${id}/revoke`,{method:'POST',body:{}});await load();}catch(e){error.value=errorText(e);}finally{busy.value=false;}}
onMounted(load);
</script>
<template>
  <div class="delegations-panel">
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <section class="detail-section"><div class="section-heading"><h2>新增代报授权</h2><button class="icon-button" title="刷新授权" aria-label="刷新授权" :disabled="busy" @click="load"><RefreshCw :size="17"/></button></div>
      <form class="request-form" @submit.prevent="grant">
        <div class="form-grid"><label>受托支持人员<select v-model="delegate" required><option value="">请选择</option><option v-for="person in candidates" :key="person.id" :value="person.id">{{person.name}}</option></select></label>
        <label>授权有效期<select v-model="hours"><option :value="1">1 小时</option><option :value="8">8 小时</option><option :value="24">24 小时</option><option :value="72">3 天</option><option :value="168">7 天</option></select></label></div>
        <label class="checkbox-label"><input v-model="consent" type="checkbox" required/>同意受托人代我提交普通工单，并查看、补充本授权下的工单；不授权审批、确认交付或再次委托。</label>
        <div class="form-footer"><button class="primary" type="submit" :disabled="busy||!consent||!delegate"><LoaderCircle v-if="busy" class="spin" :size="16"/><Check v-else :size="16"/>确认授权</button></div>
      </form>
    </section>
    <section class="detail-section"><h2>授权记录</h2><ul class="delegation-list"><li v-for="item in grants" :key="item.id"><div><strong>{{item.requesterId===user.id?`我 → ${item.delegateName}`:`${item.requesterName} → 我`}}</strong><p class="muted">{{item.revokedAt?'已撤销':item.active?'有效':'已过期或人员不可用'}} · 截止 {{formatDate(item.expiresAt)}}</p></div><button v-if="item.requesterId===user.id&&item.active" class="secondary" :disabled="busy" @click="revoke(item.id)"><X :size="16"/>撤销授权</button></li></ul><p v-if="!grants.length" class="muted">暂无授权记录</p></section>
  </div>
</template>
