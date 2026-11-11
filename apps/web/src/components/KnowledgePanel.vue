<script setup lang="ts">
import { computed,onMounted,ref } from 'vue';
import { ArrowLeft,BookOpen,Check,FilePlus2,RefreshCw,Search } from 'lucide-vue-next';
import type { SessionUser } from '@itsm/contracts';
import { api,errorText } from '../api';
import { formatDate } from '../labels';

type Role={groupId:string;editor:boolean;reviewer:boolean};
type Article={id:string;status?:string;draftVersion?:number;publishedVersion?:number|null;version?:number;
  groupId?:string;authorId?:string;reviewedBy?:string|null;title:string;body:string;audience:string;
  reviewDueAt:string;publishedAt?:string};
const props=defineProps<{user:SessionUser}>();
const roles=ref<Role[]>([]),scope=ref<'published'|'managed'>('published'),items=ref<Article[]>([]);
const selected=ref<Article>(),search=ref(''),error=ref(''),busy=ref(false),formOpen=ref(false);
const form=ref({groupId:'',title:'',body:'',audience:'EMPLOYEE',dueDate:''});
const activeRole=computed(()=>roles.value.find(role=>role.groupId===selected.value?.groupId));
const isAuthor=computed(()=>selected.value?.authorId===props.user.id);
const canEdit=computed(()=>!!activeRole.value?.editor && isAuthor.value);
const canReview=computed(()=>!!activeRole.value?.reviewer && !isAuthor.value);
const labels:Record<string,string>={DRAFT:'草稿',IN_REVIEW:'待审校',APPROVED:'已审校',PUBLISHED:'已发布',ARCHIVED:'已归档'};

async function load(){
  busy.value=true;error.value='';
  try{
    const params=new URLSearchParams();if(scope.value==='managed')params.set('scope','managed');if(search.value)params.set('search',search.value);
    items.value=(await api<{items:Article[]}>(`/knowledge?${params}`)).items;
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
async function open(item:Article){
  busy.value=true;error.value='';
  try{selected.value=await api<Article>(`/knowledge/${item.id}${scope.value==='managed'?'?scope=managed':''}`);}
  catch(e){error.value=errorText(e);await load();}finally{busy.value=false;}
}
function startForm(){
  const due=new Date();due.setDate(due.getDate()+30);
  form.value={groupId:selected.value?.groupId??roles.value.find(role=>role.editor)?.groupId??'',
    title:selected.value?.title??'',body:selected.value?.body??'',audience:selected.value?.audience??'EMPLOYEE',
    dueDate:selected.value?.reviewDueAt?.slice(0,10)??due.toISOString().slice(0,10)};
  formOpen.value=true;error.value='';
}
async function save(){
  busy.value=true;error.value='';
  try{
    const date=new Date(`${form.value.dueDate}T23:59:00`);
    if(!Number.isFinite(date.getTime()))throw new Error('INVALID_DATE');
    const body={contentClass:'GENERAL',title:form.value.title,body:form.value.body,audience:form.value.audience,reviewDueAt:date.toISOString()};
    selected.value=selected.value
      ? await api<Article>(`/knowledge/${selected.value.id}/revise`,{method:'POST',key:crypto.randomUUID(),body:{...body,expectedVersion:selected.value.draftVersion}})
      : await api<Article>('/knowledge',{method:'POST',key:crypto.randomUUID(),body:{...body,groupId:form.value.groupId}});
    scope.value='managed';formOpen.value=false;await load();
  }catch(e){error.value=e instanceof Error&&e.message==='INVALID_DATE'?'请选择复核日期。':errorText(e);}
  finally{busy.value=false;}
}
async function transition(action:string){
  if(!selected.value)return;
  busy.value=true;error.value='';
  try{
    selected.value=await api<Article>(`/knowledge/${selected.value.id}/${action}`,{
      method:'POST',key:crypto.randomUUID(),body:{expectedVersion:selected.value.draftVersion},
    });
    await load();
  }catch(e){error.value=errorText(e);}finally{busy.value=false;}
}
function changeScope(next:'published'|'managed'){scope.value=next;selected.value=undefined;formOpen.value=false;void load();}
onMounted(async()=>{try{roles.value=(await api<{groups:Role[]}>('/knowledge/roles')).groups;}catch(e){error.value=errorText(e);}await load();});
</script>

<template>
  <section class="knowledge-panel">
    <div class="list-toolbar">
      <div class="segmented" aria-label="知识范围"><button :class="{selected:scope==='published'}" @click="changeScope('published')">已发布</button><button v-if="roles.length" :class="{selected:scope==='managed'}" @click="changeScope('managed')">内容管理</button></div>
      <form class="knowledge-search" @submit.prevent="load"><label class="sr-only" for="knowledge-search">搜索知识</label><input id="knowledge-search" v-model.trim="search" maxlength="100" placeholder="搜索标题或内容"/><button class="icon-button" title="搜索" aria-label="搜索" type="submit"><Search :size="18"/></button></form>
      <button v-if="scope==='managed'&&roles.some(role=>role.editor)" class="primary" @click="selected=undefined;startForm()"><FilePlus2 :size="17"/>新建知识</button>
    </div>
    <p v-if="error" class="error-banner" role="alert">{{error}}<button class="text-button" @click="load">重试</button></p>
    <div v-if="formOpen" class="knowledge-detail">
      <button class="text-button" @click="formOpen=false"><ArrowLeft :size="16"/>返回</button>
      <h2>{{selected?'修订知识':'新建知识'}}</h2>
      <p class="muted">仅填写一般支持内容；密码、密钥及安全事件证据请使用安全联络渠道。</p>
      <form class="knowledge-form" @submit.prevent="save">
        <label v-if="!selected">责任组<select v-model="form.groupId" required><option v-for="role in roles.filter(role=>role.editor)" :key="role.groupId" :value="role.groupId">{{role.groupId}}</option></select></label>
        <label>标题<input v-model.trim="form.title" required maxlength="160"/></label>
        <label>正文<textarea v-model.trim="form.body" required maxlength="12000" rows="9"/></label>
        <div class="knowledge-form-row"><label>受众<select v-model="form.audience"><option value="EMPLOYEE">全体员工</option><option value="SUPPORT_GROUP">责任组</option></select></label><label>复核日期<input v-model="form.dueDate" type="date" required/></label></div>
        <div class="action-list"><button class="primary" type="submit" :disabled="busy"><Check :size="17"/>保存草稿</button><button class="secondary" type="button" @click="formOpen=false">取消</button></div>
      </form>
    </div>
    <div v-else-if="selected" class="knowledge-detail">
      <button class="text-button" @click="selected=undefined"><ArrowLeft :size="16"/>返回列表</button>
      <div class="section-heading"><h2>{{selected.title}}</h2><span v-if="selected.status" class="status">{{labels[selected.status]??selected.status}}</span></div>
      <p class="muted">{{selected.audience==='EMPLOYEE'?'全体员工':'责任组'}} · 复核 {{formatDate(selected.reviewDueAt)}} · 版本 {{selected.draftVersion??selected.version}}</p>
      <p class="multiline knowledge-body">{{selected.body}}</p>
      <div v-if="scope==='managed'" class="action-list">
        <button v-if="canEdit&&(selected.status==='DRAFT'||selected.status==='PUBLISHED')" class="secondary" @click="startForm">修订</button>
        <button v-if="canEdit&&selected.status==='DRAFT'" class="primary" :disabled="busy" @click="transition('submit')">提交审校</button>
        <button v-if="canReview&&selected.status==='IN_REVIEW'" class="primary" :disabled="busy" @click="transition('approve')">审校通过</button>
        <button v-if="canReview&&selected.status==='IN_REVIEW'" class="secondary" :disabled="busy" @click="transition('reject')">退回草稿</button>
        <button v-if="activeRole?.editor&&selected.status==='APPROVED'&&selected.reviewedBy!==user.id" class="primary" :disabled="busy" @click="transition('publish')">发布</button>
        <button v-if="activeRole?.editor&&selected.status!=='ARCHIVED'&&selected.publishedVersion" class="secondary" :disabled="busy" @click="transition('archive')">归档</button>
      </div>
    </div>
    <div v-else class="table-wrap" :aria-busy="busy"><table><thead><tr><th>标题</th><th v-if="scope==='managed'">状态</th><th>受众</th><th>{{scope==='managed'?'复核日期':'发布时间'}}</th></tr></thead><tbody><tr v-for="item in items" :key="item.id"><td><button class="ticket-link" @click="open(item)"><strong>{{item.title}}</strong></button></td><td v-if="scope==='managed'"><span class="status">{{labels[item.status??'']??item.status}}</span></td><td>{{item.audience==='EMPLOYEE'?'全体员工':'责任组'}}</td><td>{{formatDate(item.reviewDueAt??item.publishedAt??'')}}</td></tr></tbody></table><div v-if="!items.length" class="empty-state"><RefreshCw v-if="busy" class="spin" :size="26"/><BookOpen v-else :size="28"/><p>{{busy?'正在加载':'暂无可查看的知识'}}</p></div></div>
  </section>
</template>

<style scoped>
.knowledge-panel{min-width:0}
.knowledge-panel .list-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.knowledge-search{display:flex;gap:8px;min-width:180px;flex:1;max-width:420px}
.knowledge-search input{margin:0;min-height:36px}
.knowledge-detail{max-width:860px;background:#fff;border-top:1px solid #dfe5e8;padding:22px 0}
.knowledge-detail h2{font-size:18px;margin:18px 0 6px;overflow-wrap:anywhere}
.knowledge-detail .section-heading{margin:16px 0 4px;align-items:flex-start;gap:12px}
.knowledge-detail .section-heading h2{margin:0}
.knowledge-body{margin:24px 0;padding:18px 0;border-top:1px solid #e6ebed;border-bottom:1px solid #e6ebed;line-height:1.8}
.knowledge-form{display:grid;gap:18px;margin-top:20px}
.knowledge-form-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.knowledge-detail .action-list{margin-top:20px}
.knowledge-panel .table-wrap{background:white}
.knowledge-panel .ticket-link{text-align:left;max-width:100%;overflow-wrap:anywhere}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:760px){.knowledge-search{order:2;max-width:none;flex-basis:100%}.knowledge-form-row{grid-template-columns:minmax(0,1fr)}.knowledge-panel th:last-child,.knowledge-panel td:last-child{display:none}.knowledge-detail{padding-top:14px}}
</style>
