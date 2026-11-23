<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {ArrowRight,ClipboardList,LayoutGrid,Monitor,Network,Search,Send,X} from 'lucide-vue-next';
import type {CatalogItem} from '@itsm/contracts';
const props=defineProps<{catalog:CatalogItem[]}>();
const emit=defineEmits<{select:[code:string]}>();
const category=ref(''),system=ref(''),query=ref('');
const path=(item:CatalogItem)=>item.navigationPath?.length?item.navigationPath:['其他服务'];
const categories=computed(()=>[...new Set(props.catalog.map(item=>path(item)[0]))]);
const systems=computed(()=>[...new Set(props.catalog.filter(item=>!category.value||path(item)[0]===category.value)
  .flatMap(item=>path(item)[1]?[path(item)[1]]:[]))]);
watch(category,()=>{system.value='';});
watch(categories,values=>{if(category.value&&!values.includes(category.value)){category.value='';system.value='';}});
watch(systems,values=>{if(system.value&&!values.includes(system.value))system.value='';});
const filtered=computed(()=>{
  const words=query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return props.catalog.filter(item=>(!category.value||path(item)[0]===category.value)
    &&(!system.value||path(item)[1]===system.value)
    &&words.every(word=>[item.name,item.description,...path(item)].join(' ').toLocaleLowerCase().includes(word)));
});
const sections=computed(()=>[
  {key:'support',name:'故障与支持',items:filtered.value.filter(item=>item.available&&item.type!=='REQ')},
  {key:'request',name:'服务申请',items:filtered.value.filter(item=>item.available&&item.type==='REQ')},
].map(section=>{
  const groups=new Map<string,{key:string;name:string;items:CatalogItem[]}>();
  for(const item of section.items){
    const key=JSON.stringify(path(item));
    if(!groups.has(key))groups.set(key,{key,name:path(item).join(' / '),items:[]});
    groups.get(key)!.items.push(item);
  }
  return {...section,groups:[...groups.values()]};
}));
const unavailable=computed(()=>filtered.value.filter(item=>!item.available));
function reset(){category.value='';system.value='';query.value='';}
</script>
<template>
  <div class="catalog-browser">
    <div class="catalog-filters">
      <label class="catalog-search"><Search :size="18"/><input v-model="query" type="search" aria-label="搜索服务" placeholder="搜索服务名称或问题" maxlength="200"/></label>
      <label v-if="systems.length" class="catalog-system">业务系统 / 分类<select v-model="system" aria-label="业务系统或子分类"><option value="">全部</option><option v-for="name in systems" :key="name">{{name}}</option></select></label>
    </div>
    <nav class="catalog-categories" aria-label="服务分类">
      <button :class="{selected:!category}" :aria-pressed="!category" @click="category=''">全部<span>{{catalog.length}}</span></button>
      <button v-for="name in categories" :key="name" :class="{selected:category===name}" :aria-pressed="category===name" @click="category=name">{{name}}<span>{{catalog.filter(item=>path(item)[0]===name).length}}</span></button>
    </nav>
    <template v-if="filtered.length">
      <section v-for="section in sections" v-show="section.items.length" :key="section.key" class="catalog-section" :aria-labelledby="`catalog-${section.key}-title`">
        <div class="section-heading"><h2 :id="`catalog-${section.key}-title`">{{section.name}}</h2><span class="muted">{{section.items.length}} 项服务</span></div>
        <div v-for="group in section.groups" :key="group.key" class="catalog-group"><h3>{{group.name}}</h3>
          <div class="catalog-grid"><button v-for="item in group.items" :key="item.code" class="catalog-item" @click="emit('select',item.code)">
            <span class="service-icon"><ClipboardList v-if="item.type==='REQ'" :size="22"/><Network v-else-if="item.code==='INC-NET'" :size="22"/><Monitor v-else-if="item.code==='INC-PC'" :size="22"/><Send v-else-if="item.code==='INC-MAIL'" :size="22"/><LayoutGrid v-else :size="22"/></span>
            <span><strong>{{item.name}}</strong><small>{{item.description}}</small></span><ArrowRight :size="18"/>
          </button></div>
        </div>
      </section>
      <section v-if="unavailable.length" class="catalog-section" aria-label="暂未开放服务"><h2>暂未开放</h2><div class="request-catalog"><div v-for="item in unavailable" :key="item.code"><span>{{item.name}}<small>{{path(item).join(' / ')}}</small></span><span class="muted">暂未开放</span></div></div></section>
    </template>
    <div v-else class="empty-state"><Search :size="26"/><p>未找到匹配的服务</p><button v-if="query||category||system" @click="reset"><X :size="16"/>清除筛选</button></div>
  </div>
</template>
<style scoped>
.catalog-filters{display:flex;gap:16px;align-items:end;flex-wrap:wrap;margin-bottom:16px}.catalog-search{display:flex;align-items:center;gap:10px;flex:1;min-width:200px;max-width:520px;border:1px solid #dfe5e8;border-radius:6px;padding:0 12px;background:#fff}.catalog-search input{border:0;min-width:0;width:100%;background:transparent}.catalog-system{display:grid;gap:6px;font-size:12px;min-width:180px}.catalog-categories{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}.catalog-categories button{gap:10px;min-height:38px;background:#fff}.catalog-categories button.selected{background:#edf8f4;border-color:#147e76;color:#146c65}.catalog-categories span{font-size:11px;color:#65747c}.catalog-group{margin:16px 0 22px}.catalog-group h3{font-size:13px;font-weight:600;color:#53636b;margin:0 0 10px;overflow-wrap:anywhere}.catalog-item>span:nth-child(2){min-width:0;overflow-wrap:anywhere}.catalog-item>svg{flex-shrink:0}.request-catalog small{display:block;color:#65747c;margin-top:5px;font-size:11px}@media(max-width:760px){.catalog-filters{align-items:stretch;gap:12px}.catalog-search{min-width:0;max-width:none;flex-basis:100%}.catalog-system{width:100%;min-width:0}.catalog-categories{gap:6px}.catalog-categories button{max-width:100%;white-space:normal;text-align:left;overflow-wrap:anywhere}.catalog-group h3{line-height:1.5}}
</style>
