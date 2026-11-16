import type { ServiceStructure,ServiceStructureOptions } from './service-structure.js';

// Suggested starting data only; neither validation nor routing restricts users to these entries.
export const COMPANY_SERVICE_STRUCTURE_TEMPLATE = [
  {id:'it-infrastructure',name:'IT 基础设施运维',systems:[],positions:[
    {id:'helpdesk',name:'Helpdesk 工程师'},{id:'network',name:'网络工程师'},
    {id:'systems',name:'系统工程师'},{id:'assets',name:'资产管理员'},
  ]},
  {id:'information-systems',name:'信息系统运维',systems:[
    {id:'erp',name:'ERP'},{id:'srm',name:'SRM'},{id:'wms',name:'WMS'},
    {id:'oa',name:'OA'},{id:'agv',name:'AGV'},{id:'pdm',name:'PDM'},
    {id:'cost',name:'COST'},{id:'hub',name:'HUB'},{id:'tb',name:'TB'},
    {id:'dingtalk',name:'钉钉'},{id:'mail',name:'邮件'},
  ],positions:[
    {id:'erp',name:'ERP 运维工程师'},{id:'srm',name:'SRM 运维工程师'},
    {id:'wms',name:'WMS 运维工程师'},{id:'oa',name:'OA 运维工程师'},
    {id:'agv',name:'AGV 运维工程师'},{id:'pdm',name:'PDM 运维工程师'},
    {id:'cost',name:'COST 运维工程师'},{id:'hub',name:'HUB 运维工程师'},
    {id:'tb',name:'TB 运维工程师'},{id:'dingtalk',name:'钉钉运维工程师'},
    {id:'mail',name:'邮件运维工程师'},
  ]},
] as const;

export interface StructureTemplateSelection {domainId:string;groupId:string}
export interface StructureTemplateEntry {kind:'domains'|'systems'|'positions';id:string;name:string;enabled:boolean}
export interface StructureTemplateConflict {id:string;name:string;reason:'SELECTION'|'GROUP'|'NAME'|'DOMAIN'}
const normalized=(name:string)=>name.normalize('NFKC').trim().toLowerCase();

export function addCompanyServiceStructureTemplate(
  current:ServiceStructure,groups:ServiceStructureOptions['groups'],selection:StructureTemplateSelection[],
):{config:ServiceStructure;added:StructureTemplateEntry[];retained:StructureTemplateEntry[];conflicts:StructureTemplateConflict[]} {
  const config:ServiceStructure=JSON.parse(JSON.stringify(current)),added:StructureTemplateEntry[]=[],retained:StructureTemplateEntry[]=[];
  const conflicts:StructureTemplateConflict[]=[],selected=new Set<string>();
  for(const choice of selection){
    const template=COMPANY_SERVICE_STRUCTURE_TEMPLATE.find(row=>row.id===choice.domainId);
    if(!template||selected.has(choice.domainId)){
      conflicts.push({id:choice.domainId,name:choice.domainId,reason:'SELECTION'});continue;
    }
    selected.add(choice.domainId);
    if(!groups.some(row=>row.id===choice.groupId)){
      conflicts.push({id:choice.groupId,name:template.name,reason:'GROUP'});continue;
    }
    const domainId=`tpl-${template.id}`;
    function merge(kind:'domains'|'systems'|'positions',row:ServiceStructure[typeof kind][number]){
      const collection=config[kind] as typeof row[];
      const existing=collection.find(item=>item.id===row.id);
      if(existing){
        if('domainId' in row&&(!('domainId' in existing)||existing.domainId!==row.domainId))
          conflicts.push({id:row.id,name:row.name,reason:'DOMAIN'});
        else retained.push({kind,id:existing.id,name:existing.name,enabled:existing.enabled});
      }else if(collection.some(item=>normalized(item.name)===normalized(row.name)))
        conflicts.push({id:row.id,name:row.name,reason:'NAME'});
      else {collection.push(row);added.push({kind,id:row.id,name:row.name,enabled:row.enabled});}
    }
    merge('domains',{id:domainId,name:template.name,enabled:false});
    for(const system of template.systems)
      merge('systems',{id:`tpl-system-${system.id}`,name:system.name,domainId,enabled:false});
    for(const position of template.positions)
      merge('positions',{id:`tpl-position-${position.id}`,name:position.name,domainId,groupId:choice.groupId,enabled:false});
  }
  // A name or parent collision needs an explicit administrator decision, never a partial import.
  return {config:conflicts.length?JSON.parse(JSON.stringify(current)):config,added:conflicts.length?[]:added,retained,conflicts};
}
