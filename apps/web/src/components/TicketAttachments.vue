<script setup lang="ts">
import { onMounted,ref,watch } from 'vue';
import { Download,LoaderCircle,Paperclip,RefreshCw,Upload } from 'lucide-vue-next';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api,attachmentRequest,errorText } from '../api';
import { createRequestKey } from '../request-key';
import { formatDate } from '../labels';
import ContentBoundary from './ContentBoundary.vue';
type Item={id:string;name:string;mime:string;size:number;visibility:'PUBLIC'|'INTERNAL';scanStatus:string;createdAt:string};
type Listing={items:Item[];enabled:boolean;configured:boolean;canUpload:boolean;canInternal:boolean;maxBytes:number};
type Grant={id?:string;url:string;headers:Record<string,string>};
const props=defineProps<{ticketId:string;version:number}>();
const listing=ref<Listing>(),error=ref(''),busy=ref(false),loading=ref(false),file=ref<File>(),input=ref<HTMLInputElement>();
const visibility=ref<'PUBLIC'|'INTERNAL'>('PUBLIC'),safe=ref(false),notice=ref('');
const states:Record<string,string>={PENDING:'待上传',UPLOADING:'上传中',SCANNING:'安全扫描中',CLEAN:'已通过扫描',QUARANTINED:'已隔离，禁止下载',FAILED:'校验或扫描未通过'};
const size=(n:number)=>n>=1048576?`${(n/1048576).toFixed(1)} MB`:`${Math.ceil(n/1024)} KB`;
watch(file,()=>{safe.value=false;});
watch(visibility,()=>{safe.value=false;notice.value='';});
async function load(){
  loading.value=true;
  try{listing.value=await api<Listing>(`/tickets/${props.ticketId}/attachments`);if(!listing.value.canInternal)visibility.value='PUBLIC';}
  catch(e){error.value=errorText(e);}finally{loading.value=false;}
}
function choose(event:Event){file.value=(event.target as HTMLInputElement).files?.[0];error.value='';notice.value='';}
async function upload(){
  const selected=file.value;if(!selected||!safe.value||busy.value||!listing.value?.canUpload)return;
  if(selected.size<1||selected.size>listing.value.maxBytes){error.value=`文件大小须在 1 字节至 ${size(listing.value.maxBytes)} 之间。`;return;}
  busy.value=true;error.value='';notice.value='正在上传并扫描';
  try{
    const extensions:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',pdf:'application/pdf',txt:'text/plain',log:'text/plain',csv:'text/csv'};
    const mime=extensions[selected.name.split('.').pop()?.toLowerCase()??''];
    const digest=bytesToHex(sha256(new Uint8Array(await selected.arrayBuffer())));
    const grant=await api<Grant>(`/tickets/${props.ticketId}/attachments/presign`,{method:'POST',key:createRequestKey(),
      body:{contentClass:'GENERAL',name:selected.name,mime,size:selected.size,sha256:digest,visibility:visibility.value}});
    const response=await attachmentRequest(grant.url,'PUT',grant.headers,selected),result=await response.json();
    notice.value=result.scanStatus==='CLEAN'?'附件已上传并通过扫描。':'附件已隔离，禁止下载。';
    file.value=undefined;safe.value=false;if(input.value)input.value.value='';
  }catch(e){error.value=errorText(e);notice.value='';}
  finally{busy.value=false;await load();}
}
async function download(item:Item){
  if(busy.value)return;busy.value=true;error.value='';
  try{
    const grant=await api<Grant>(`/tickets/${props.ticketId}/attachments/${item.id}/download`,{method:'POST'});
    const response=await attachmentRequest(grant.url,'GET',grant.headers),blob=await response.blob(),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download=item.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
watch(()=>props.version,load);onMounted(load);
</script>
<template>
  <section class="detail-section attachment-section" aria-label="工单附件">
    <div class="section-heading"><h2><Paperclip :size="17"/>附件</h2><button class="icon-button" title="刷新附件" aria-label="刷新附件" :disabled="loading||busy" @click="load"><RefreshCw :size="16" :class="{spin:loading}"/></button></div>
    <p v-if="error" class="error-banner" role="alert">{{error}}</p>
    <p v-if="notice" class="muted" role="status">{{notice}}</p>
    <p v-if="loading&&!listing" class="muted">正在加载附件</p>
    <template v-if="listing">
      <ul v-if="listing.items.length" class="attachment-list"><li v-for="item in listing.items" :key="item.id">
        <div class="attachment-info"><strong>{{item.name}}</strong><small>{{size(item.size)}} · {{item.visibility==='INTERNAL'?'工程师内部':'员工可见'}} · {{formatDate(item.createdAt)}}</small><span :class="item.scanStatus==='QUARANTINED'||item.scanStatus==='FAILED'?'danger-text':'muted'">{{states[item.scanStatus]??'待核验'}}</span></div>
        <button v-if="item.scanStatus==='CLEAN'" class="icon-button" :title="`下载 ${item.name}`" :aria-label="`下载 ${item.name}`" :disabled="busy" @click="download(item)"><Download :size="18"/></button>
      </li></ul>
      <p v-else class="muted">暂无附件</p>
      <form v-if="listing.canUpload" class="attachment-form" @submit.prevent="upload">
        <label>添加附件<input ref="input" type="file" accept=".png,.jpg,.jpeg,.pdf,.txt,.log,.csv" :disabled="busy" @change="choose"/></label>
        <label v-if="listing.canInternal">可见范围<select v-model="visibility" :disabled="busy"><option value="PUBLIC">员工可见</option><option value="INTERNAL">工程师内部</option></select></label>
        <p class="caption">单个文件最多 {{size(listing.maxBytes)}}。请勿上传密码、密钥、个人敏感资料或安全事件证据。</p>
        <ContentBoundary v-if="file" v-model="safe"/>
        <div class="form-footer"><button class="primary" type="submit" :disabled="busy||!file||!safe"><LoaderCircle v-if="busy" class="spin" :size="16"/><Upload v-else :size="16"/>{{busy?'正在上传并扫描':'上传附件'}}</button></div>
      </form>
      <p v-else-if="!listing.configured" class="muted">当前环境尚未开放附件上传。</p>
    </template>
  </section>
</template>
<style scoped>
.attachment-list{list-style:none;margin:0;padding:0}.attachment-list li{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid #e5e8eb}.attachment-info{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.attachment-info strong{overflow-wrap:anywhere;font-size:14px}.attachment-info small{color:#647078;font-size:12px}.attachment-info span{font-size:12px}.attachment-form{display:grid;gap:14px;padding-top:18px}.attachment-form input[type=file]{max-width:100%;min-width:0;font-size:13px}.attachment-form select{max-width:260px}
</style>
