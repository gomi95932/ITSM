<script setup lang="ts">
import { computed,onBeforeUnmount,onMounted,ref,watch } from 'vue';
import * as dd from 'dingtalk-jsapi';
import { Activity,BarChart3,Bell,BookOpen,ChevronLeft,ChevronRight,ClipboardList,Headphones,LayoutGrid,LoaderCircle,LogOut,Network,Plus,QrCode,RefreshCw,ShieldCheck,TriangleAlert,UserRound,Users } from 'lucide-vue-next';
import type { CatalogItem,SessionUser,TicketListResponse,TicketView,WorkQueue,WorkQueueCounts } from '@itsm/contracts';
import EmployeeForm from './components/EmployeeForm.vue';
import CatalogBrowser from './components/CatalogBrowser.vue';
import TicketDetail from './components/TicketDetail.vue';
import DelegationsPanel from './components/DelegationsPanel.vue';
import KnowledgePanel from './components/KnowledgePanel.vue';
import ReportsPanel from './components/ReportsPanel.vue';
import RolesPanel from './components/RolesPanel.vue';
import RoutingAlertsPanel from './components/RoutingAlertsPanel.vue';
import RoutingConfigPanel from './components/RoutingConfigPanel.vue';
import PriorityConfigPanel from './components/PriorityConfigPanel.vue';
import ServiceStructurePanel from './components/ServiceStructurePanel.vue';
import SupportStructurePanel from './components/SupportStructurePanel.vue';
import OperationsPanel from './components/OperationsPanel.vue';
import AppointmentsPanel from './components/AppointmentsPanel.vue';
import WorkQueueTabs from './components/WorkQueueTabs.vue';
import FulfillmentPanel from './components/FulfillmentPanel.vue';
import DirectoryPanel from './components/DirectoryPanel.vue';
import { api,ApiError,devUser,errorText,setUser,useDevelopment } from './api';
import { formatDate,statuses } from './labels';

type View='mine'|'catalog'|'queue'|'notifications'|'delegations'|'knowledge'|'reports'|'roles'|'routing'|'routing-config'|'priority-config'|'service-structure'|'support-structure'|'fulfillments'|'directory'|'operations'|'appointments';
type Delivery={id:string;state:string;attempts:number;lastError:string|null;updatedAt:string;number:string;canRetry:boolean};
const user=ref<SessionUser>(),booting=ref(true),error=ref(''),loading=ref(false),development=ref(false),identity=ref(devUser());
const enterpriseLogin=ref(false),dingtalkWebLogin=ref(false);
const view=ref<View>('mine'),catalog=ref<CatalogItem[]>([]),tickets=ref<TicketView[]>([]),counts=ref<Record<string,number>>({}),total=ref(0),page=ref(1),filter=ref('');
const workQueue=ref<WorkQueue>('all');
const emptyWorkQueues=():WorkQueueCounts=>({all:0,assigned:0,incoming:0,outgoing:0,unassigned:0});
const workQueues=ref<WorkQueueCounts>(emptyWorkQueues());
const selected=ref(''),creating=ref(false),initialCode=ref(''),notices=ref<Delivery[]>([]),notificationMode=ref('disabled'),retrying=ref('');
const pages=computed(()=>Math.max(1,Math.ceil(total.value/20)));
const openCount=computed(()=>Object.entries(counts.value).filter(([status])=>!['CLOSED','CANCELLED','REJECTED'].includes(status)).reduce((sum,[,count])=>sum+count,0));
const noticeLabels:Record<string,string>={PENDING:'待发送',DISPATCHING:'正在提交',SENDING:'平台受理，待确认',DELIVERED:'平台确认发送成功',SIMULATED:'开发模拟',DEAD:'失败待处理',SKIPPED:'已跳过',REVIEW_REQUIRED:'发送结果待核查'};
const needsNoticeAttention=(item:Delivery)=>['DEAD','REVIEW_REQUIRED'].includes(item.state);
const title=computed(()=>({mine:'我的工单',catalog:'服务目录',queue:'IT 工作台',notifications:'消息通知',delegations:'代报授权',knowledge:'知识库',reports:'服务报表',roles:'角色授权',routing:'路由告警','routing-config':'派单配置','priority-config':'分级与时限','service-structure':'服务组织','support-structure':'支持组',fulfillments:'交付与回收',directory:'人员同步',operations:'厂区与服务时限',appointments:'岗位任职'})[view.value]);
let refreshTimer:ReturnType<typeof setInterval>|undefined;
let generation=0;
let bootGeneration=0;
async function boot(){
  const generationId=++bootGeneration;++generation;booting.value=true;error.value='';user.value=undefined;setUser(null);
  try{
    const config=await api<{mode:string;corpId:string;configured:boolean;oidcConfigured?:boolean;dingtalkWebConfigured?:boolean}>('/auth/config');
    enterpriseLogin.value=!!config.oidcConfigured;
    dingtalkWebLogin.value=!!config.dingtalkWebConfigured;
    development.value=config.mode==='development';useDevelopment(development.value);
    if(!development.value){
      try{user.value=await api<SessionUser>('/auth/me');}
      catch(e){
        if(!(e instanceof ApiError)||e.status!==401)throw e;
        if(dd.env.platform==='notInDingTalk'||!config.configured){
          if(enterpriseLogin.value||dingtalkWebLogin.value){
            error.value=new URLSearchParams(location.search).get('login')==='failed'?'企业登录未完成，请重试或联系管理员核对身份关联。':'请使用公司钉钉账号或企业账号登录。';
            return;
          }
          throw new Error(config.configured?'请从钉钉工作台进入 IT 服务台。':'企业登录尚未配置，请联系管理员。');
        }
        const code=await new Promise<string>((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error('钉钉授权超时，请重新进入应用。')),15000);
          dd.ready(()=>{
            dd.runtime.permission.requestAuthCode({corpId:config.corpId})
              .then(result=>{clearTimeout(timeout);resolve(result.code);})
              .catch(()=>{clearTimeout(timeout);reject(new Error('钉钉授权未完成，请重新进入应用。'));});
          });
        });
        await api('/auth/dingtalk',{method:'POST',body:{code}});user.value=await api<SessionUser>('/auth/me');
      }
    }else{user.value=await api<SessionUser>('/auth/me');}
    if(generationId!==bootGeneration)return;
    setUser(user.value!);catalog.value=(await api<{items:CatalogItem[]}>('/catalog')).items;
    syncHash();await load();
  }catch(e){error.value=e instanceof ApiError?errorText(e):e instanceof Error?e.message:'无法打开服务台。';}
  finally{if(generationId===bootGeneration)booting.value=false;}
}
async function load(quiet=false){
  if(!user.value)return;const current=++generation;
  if(!quiet)loading.value=true;error.value='';
  try{
    if(view.value==='catalog'){
      const result=await api<{items:CatalogItem[]}>('/catalog');if(current!==generation)return;
      catalog.value=result.items;
    }else if(view.value==='notifications'){
      const result=await api<{items:Delivery[];mode:string}>('/notifications');if(current!==generation)return;
      notices.value=result.items;notificationMode.value=result.mode;
    }else if(!['catalog','delegations','knowledge','reports','roles','routing','routing-config','priority-config','service-structure','support-structure','fulfillments','directory'].includes(view.value)){
      const result=await api<TicketListResponse>(`/tickets?mine=${view.value!=='queue'}&page=${page.value}&size=20${view.value==='queue'?`&queue=${workQueue.value}`:''}${filter.value?`&status=${filter.value}`:''}`);
      if(current!==generation)return;tickets.value=result.items;total.value=result.total;counts.value=result.counts;
      workQueues.value=result.workQueues??emptyWorkQueues();
    }
  }catch(e){if(current===generation)error.value=errorText(e);}finally{if(current===generation)loading.value=false;}
}
function navigate(value:View){view.value=value;filter.value='';workQueue.value='all';page.value=1;selected.value='';creating.value=false;history.replaceState(null,'',location.pathname+location.search);void load();}
function selectWorkQueue(value:WorkQueue){if(value===workQueue.value)return;workQueue.value=value;filter.value='';page.value=1;void load();}
function openTicket(id:string){creating.value=false;location.hash=`/tickets/${id}`;}
function syncHash(){
  if(location.hash==='#/fulfillments'){view.value=user.value?.groups.length?'fulfillments':'mine';selected.value='';creating.value=false;return;}
  if(location.hash==='#/routing-alerts'){view.value='routing';selected.value='';return;}
  const match=/^#\/tickets\/([a-f0-9-]{36})$/.exec(location.hash);selected.value=match?.[1]??'';
}
function back(){selected.value='';creating.value=false;history.replaceState(null,'',location.pathname+location.search);void load();}
function create(code=''){selected.value='';initialCode.value=code;creating.value=true;history.replaceState(null,'',location.pathname+location.search);}
async function switchIdentity(){sessionStorage.setItem('itsm-dev-user',identity.value);view.value='mine';selected.value='';creating.value=false;filter.value='';page.value=1;workQueue.value='all';workQueues.value=emptyWorkQueues();tickets.value=[];counts.value={};total.value=0;history.replaceState(null,'',location.pathname+location.search);await boot();}
async function retry(id:string){retrying.value=id;try{await api(`/notifications/${id}/retry`,{method:'POST',body:{}});await load();}catch(e){error.value=errorText(e);}finally{retrying.value='';}}
async function logout(){try{await api('/auth/logout',{method:'POST',body:{}});setUser(null);user.value=undefined;error.value='已退出，请重新进入应用。';}catch(e){error.value=errorText(e);}}
watch(filter,()=>{page.value=1;void load();});watch(page,()=>void load());
onMounted(()=>{window.addEventListener('hashchange',syncHash);void boot();refreshTimer=setInterval(()=>{if(!document.hidden&&!selected.value&&!creating.value)void load(true);},30000);});
onBeforeUnmount(()=>{window.removeEventListener('hashchange',syncHash);if(refreshTimer)clearInterval(refreshTimer);});
</script>

<template>
  <div v-if="booting" class="boot-state"><Headphones :size="32"/><LoaderCircle class="spin" :size="20"/><p>正在打开 IT 服务台</p></div>
  <div v-else-if="!user" class="boot-state"><Headphones :size="36"/><h1>IT 服务台</h1><p role="alert">{{error}}</p><a v-if="dingtalkWebLogin" class="primary enterprise-login" href="/api/v1/auth/dingtalk-web/start"><QrCode :size="18"/>钉钉扫码登录</a><a v-if="enterpriseLogin" class="primary enterprise-login" href="/api/v1/auth/oidc/start"><ShieldCheck :size="17"/>企业账号登录</a><button :class="dingtalkWebLogin||enterpriseLogin?'text-button':'primary'" @click="boot"><RefreshCw :size="17"/>重新进入</button></div>
  <div v-else class="app-shell">
    <aside class="sidebar"><a class="brand" href="#" @click.prevent="navigate('mine')"><span class="brand-icon"><Headphones :size="23"/></span><span>IT 服务台<small>祥承科技</small></span></a><p class="nav-caption">员工服务</p><nav aria-label="主要导航"><button :class="{active:view==='mine'}" @click="navigate('mine')"><ClipboardList :size="19"/>我的工单</button><button :class="{active:view==='catalog'}" @click="navigate('catalog')"><LayoutGrid :size="19"/>服务目录</button><button :class="{active:view==='knowledge'}" @click="navigate('knowledge')"><BookOpen :size="19"/>知识库</button><button :class="{active:view==='delegations'}" @click="navigate('delegations')"><UserRound :size="19"/>代报授权</button><template v-if="user.groups.length"><p class="nav-caption">支持中心</p><button :class="{active:view==='queue'}" @click="navigate('queue')"><Activity :size="19"/>IT 工作台</button><button :class="{active:view==='reports'}" @click="navigate('reports')"><BarChart3 :size="19"/>服务报表</button><button :class="{active:view==='notifications'}" @click="navigate('notifications')"><Bell :size="19"/>消息通知</button></template><template v-if="user.canManageRoles"><button :class="{active:view==='routing'}" @click="navigate('routing')"><TriangleAlert :size="19"/>路由告警</button><button :class="{active:view==='roles'}" @click="navigate('roles')"><ShieldCheck :size="19"/>角色授权</button></template>
      <button v-if="user.canManageRoles" :class="{active:view==='support-structure'}" @click="navigate('support-structure')"><Users :size="19"/>支持组</button>
      <button v-if="user.canManageRoles" :class="{active:view==='appointments'}" @click="navigate('appointments')"><Users :size="19"/>岗位任职</button>
      <button v-if="user.canManageRouting" :class="{active:view==='operations'}" @click="navigate('operations')"><Network :size="19"/>厂区与服务时限</button>
      <button v-if="user.canManageRouting" :class="{active:view==='directory'}" @click="navigate('directory')"><Users :size="19"/>人员同步</button>
      <button v-if="user.canManageRouting" :class="{active:view==='priority-config'}" @click="navigate('priority-config')"><ShieldCheck :size="19"/>分级与时限</button>
      <button v-if="user.groups.length" :class="{active:view==='fulfillments'}" @click="navigate('fulfillments')"><ClipboardList :size="19"/>交付与回收</button>
      <template v-if="user.canManageRouting"><button :class="{active:view==='service-structure'}" @click="navigate('service-structure')"><LayoutGrid :size="19"/>服务组织</button><button :class="{active:view==='routing-config'}" @click="navigate('routing-config')"><Network :size="19"/>派单配置</button></template>
      </nav><div class="sidebar-bottom"><span class="avatar"><UserRound :size="18"/></span><div><strong>{{user.name}}</strong><small>{{user.groups.length?'IT 支持人员':'员工'}}</small></div><button v-if="!development" class="icon-button" title="退出登录" aria-label="退出登录" @click="logout"><LogOut :size="17"/></button></div></aside>
    <div class="main-shell"><header class="topbar"><span class="breadcrumb">服务中心 <ChevronRight :size="14"/> {{title}}</span><label v-if="development" class="dev-switch">开发身份<select v-model="identity" aria-label="开发身份" @change="switchIdentity"><option value="employee-1">演示员工一</option><option value="employee-2">演示员工二</option><option value="agent-1">服务台工程师</option><option value="agent-2">应用支持工程师</option><option value="agent-3">服务台值班主管（演示）</option><option value="demo-admin-1">演示配置管理员一</option><option value="demo-admin-2">演示配置管理员二</option></select></label><span v-else class="connection-state"><span></span>企业账号已连接</span></header>
      <main class="content"><p v-if="error" class="error-banner" role="alert">{{error}}<button class="text-button" @click="load()">重试</button></p>
        <EmployeeForm v-if="creating" :catalog="catalog" :initial-code="initialCode" @close="back" @created="openTicket"/>
        <TicketDetail v-else-if="selected" :key="`${user.id}:${selected}`" :id="selected" :user="user" @back="back" @changed="load(true)"/>
        <template v-else>
          <div class="page-title"><div><p class="eyebrow">{{['queue','reports','routing','routing-config','priority-config','service-structure','support-structure','fulfillments','directory'].includes(view)?'SUPPORT OPERATIONS':'IT SERVICE DESK'}}</p><h1>{{title}}</h1></div><button v-if="view==='mine'||view==='catalog'" class="primary" @click="create()"><Plus :size="18"/>提交报障</button><button v-else-if="!['delegations','knowledge','reports','roles','routing','routing-config','priority-config','service-structure','support-structure','fulfillments','directory'].includes(view)" class="icon-button" title="刷新" aria-label="刷新列表" :disabled="loading" @click="load()"><RefreshCw :size="19" :class="{spin:loading}"/></button></div>
          <CatalogBrowser v-if="view==='catalog'" :catalog="catalog" @select="create"/>
          <DelegationsPanel v-else-if="view==='delegations'" :user="user"/>
          <FulfillmentPanel v-else-if="view==='fulfillments'" :key="user.id" @open="openTicket"/>
          <KnowledgePanel v-else-if="view==='knowledge'" :key="user.id" :user="user"/>
          <ReportsPanel v-else-if="view==='reports'" :key="user.id" :user="user" @open="openTicket"/>
          <RolesPanel v-else-if="view==='roles'" :key="user.id" :user="user"/>
          <DirectoryPanel v-else-if="view==='directory'&&user.canManageRouting" :key="user.id"/>
          <PriorityConfigPanel v-else-if="view==='priority-config'&&user.canManageRouting" :key="user.id" :user="user"/>
          <RoutingAlertsPanel v-else-if="view==='routing'" :key="user.id"/>
          <RoutingConfigPanel v-else-if="view==='routing-config'" :key="user.id" :user="user"/>
          <ServiceStructurePanel v-else-if="view==='service-structure'&&user.canManageRouting" :key="user.id" :user="user"/>
          <SupportStructurePanel v-else-if="view==='support-structure'&&user.canManageRoles" :key="user.id" :user="user"/>
          <OperationsPanel v-else-if="view==='operations'&&user.canManageRouting" :key="user.id" :user="user"/>
          <AppointmentsPanel v-else-if="view==='appointments'&&user.canManageRoles" :key="user.id"/>
          <template v-else-if="view==='notifications'">
            <div class="section-heading"><p class="muted">{{notificationMode==='fake'?'开发模拟':notificationMode==='dingtalk'?'钉钉通知':'发送未启用'}}</p><span class="count-badge danger">{{notices.filter(needsNoticeAttention).length}} 条待处理</span></div>
            <div class="table-wrap"><table><thead><tr><th>工单</th><th>发送状态</th><th>尝试次数</th><th>异常代码</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
              <tr v-for="item in notices" :key="item.id">
                <td>{{item.number}}</td><td><span class="status" :class="{failed:needsNoticeAttention(item)}">{{noticeLabels[item.state]??item.state}}</span></td>
                <td>{{item.attempts}}</td><td class="mono">{{item.lastError??'—'}}</td><td>{{formatDate(item.updatedAt)}}</td>
                <td><button v-if="item.state==='DEAD' && item.canRetry" class="icon-button" title="重试投递" aria-label="重试发送" :disabled="!!retrying" @click="retry(item.id)"><RefreshCw :size="17" :class="{spin:retrying===item.id}"/></button></td>
              </tr>
            </tbody></table><div v-if="!notices.length" class="empty-state"><Bell :size="28"/><p>暂无消息记录</p></div></div>
          </template>
          <template v-else>
            <WorkQueueTabs v-if="view==='queue'" :model-value="workQueue" :counts="workQueues" :loading="loading" @update:model-value="selectWorkQueue"/>
            <section class="summary-strip" aria-label="工单概况">
              <div><span>进行中</span><strong>{{openCount}}</strong></div>
              <div><span>排队中</span><strong>{{counts.QUEUED??0}}</strong></div>
              <div><span>{{view==='queue'?'等待员工补充':'待我补充'}}</span><strong class="amber-text">{{counts.WAITING_USER??0}}</strong></div>
              <div><span>{{view==='queue'?'等待确认':'待我确认'}}</span><strong class="teal-text">{{counts.PENDING_CONFIRMATION??0}}</strong></div>
            </section>
            <div class="list-toolbar">
              <div class="segmented"><button :class="{selected:!filter}" @click="filter=''">全部</button><button :class="{selected:filter==='QUEUED'}" @click="filter='QUEUED'">排队中</button><button :class="{selected:filter==='IN_PROGRESS'}" @click="filter='IN_PROGRESS'">处理中</button></div>
              <label class="filter-label">状态<select v-model="filter" aria-label="工单状态"><option value="">全部状态</option><option v-for="(label,status) in statuses" :key="status" :value="status">{{label}}</option></select></label>
            </div>
            <div class="table-wrap ticket-table" :aria-busy="loading">
              <table><thead><tr><th>工单 / 标题</th><th>状态</th><th>优先级</th><th>服务</th><th>更新时间</th><th></th></tr></thead>
                <tbody><tr v-for="ticket in tickets" :key="ticket.id">
                  <td><button class="ticket-link" @click="openTicket(ticket.id)"><span>{{ticket.number}}</span><strong>{{ticket.subject}}</strong></button>
                    <div v-if="view==='queue'" class="ticket-ownership">
                      <span>{{ticket.ownerGroupName??ticket.ownerGroupId}}</span>
                      <span>{{ticket.assigneeName??'组内未接单'}}</span>
                      <span v-if="ticket.pendingAssigneeId">待接收：{{ticket.pendingAssigneeName??ticket.pendingAssigneeId}}</span>
                    </div>
                  </td>
                  <td><span class="status" :data-status="ticket.status">{{statuses[ticket.status]}}</span></td>
                  <td><span class="priority" :data-priority="ticket.priority">{{ticket.priority}}</span></td>
                  <td>{{catalog.find(item=>item.code===ticket.serviceCode)?.name??ticket.serviceCode}}</td>
                  <td>{{formatDate(ticket.updatedAt)}}</td>
                  <td><button class="icon-button" :aria-label="`查看${ticket.number}`" title="查看工单" @click="openTicket(ticket.id)"><ChevronRight :size="18"/></button></td>
                </tr></tbody>
              </table>
              <div v-if="!tickets.length" class="empty-state"><LoaderCircle v-if="loading" class="spin" :size="28"/><ClipboardList v-else :size="32"/><h2>{{loading?'正在加载工单':'暂无工单'}}</h2><p v-if="!loading">{{filter?'当前状态没有工单。':view==='queue'?'当前队列没有工单。':'有 IT 问题，随时提交给服务台。'}}</p><button v-if="!loading&&view==='mine'&&!filter" class="primary" @click="create()"><Plus :size="17"/>提交报障</button></div>
            </div>
            <footer class="pagination"><span>共 {{total}} 条</span><div><button class="icon-button" title="上一页" aria-label="上一页" :disabled="page<=1||loading" @click="page--"><ChevronLeft :size="18"/></button><span>{{page}} / {{pages}}</span><button class="icon-button" title="下一页" aria-label="下一页" :disabled="page>=pages||loading" @click="page++"><ChevronRight :size="18"/></button></div></footer>
          </template>
        </template>
      </main><footer class="app-footer">IT 服务台 <span>·</span> {{development?'开发验证环境':'企业内部服务'}}</footer>
    </div>
  </div>
</template>

<style scoped>
.enterprise-login{display:inline-flex;align-items:center;gap:8px;text-decoration:none;padding:10px 16px;border-radius:6px;background:#087f8c;color:white}
@media(min-width:761px){.sidebar nav{min-height:0;overflow-y:auto}.sidebar-bottom{flex-shrink:0}}
.ticket-ownership{display:flex;flex-wrap:wrap;gap:4px 10px;max-width:100%;margin-top:7px;color:#61727b;font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.ticket-ownership span{min-width:0;overflow-wrap:anywhere}
@media(max-width:760px){.ticket-ownership{display:grid;gap:2px;font-size:10px}}
</style>
