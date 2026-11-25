import {createHash} from 'node:crypto';
import type {CatalogNavigationEntry,CatalogTreeNode} from '@itsm/contracts';
import {initialCatalogPath} from './catalog-navigation-policy.js';

type Service={code:string;name:string;systemId:string|null;sortOrder?:number};
type System={id:string;name:string;enabled:boolean};
const templates=[
  '账号开通申请','权限申请','权限调整与回收申请','配置调整申请',
  '配置异常','登录与使用故障','单据与业务流程异常','接口与数据异常','数据修正申请',
];
const applicationNames=['ERP系统','SRM系统','WMS系统','OA系统','AGV系统','PDM系统',
  'COST系统','HUB系统','TB系统','钉钉平台','企业邮箱'];
const systemName=(name:string)=>name==='DINGTALK'?'钉钉平台':name==='MAIL'?'企业邮箱':
  /^[A-Za-z][A-Za-z0-9_-]*$/.test(name)?`${name}系统`:name;
const id=(kind:string,value:string)=>`${kind}-${createHash('sha256').update(value).digest('hex').slice(0,20)}`;

export function initialCatalogTree(services:Service[],systems:System[],entries:CatalogNavigationEntry[]):CatalogTreeNode[]{
  const nodes:CatalogTreeNode[]=[],byId=new Map<string,CatalogTreeNode>();
  const navigation=new Map(entries.map(entry=>[entry.serviceCode,entry]));
  const add=(node:CatalogTreeNode)=>{if(!byId.has(node.id)){nodes.push(node);byId.set(node.id,node);}return byId.get(node.id)!;};
  const category=(name:string,parentId:string|null,sortOrder:number)=>add({id:id('category',`${parentId??'root'}:${name}`),parentId,
    kind:'CATEGORY',name,enabled:true,sortOrder,systemId:null,serviceCode:null});
  const uniqueName=(parentId:string,preferred:string,code:string)=>{
    const taken=(name:string)=>nodes.some(n=>n.parentId===parentId&&n.name.toLocaleLowerCase()===name.toLocaleLowerCase());
    if(!taken(preferred))return preferred;
    const suffix=` (${code})`;
    return `${preferred.slice(0,80-suffix.length)}${suffix}`;
  };
  for(const name of ['电脑与软件','账号与邮箱','网络与远程访问','打印与扫描','文件共享与存储',
    '设备与资产','入职与离职','安全与门禁','信息化系统','算力与AI服务','其他服务'])category(name,null,nodes.length*10);
  for(const [index,service] of services.entries()){
    const system=systems.find(s=>s.id===service.systemId);
    const path=navigation.get(service.code)?.path??initialCatalogPath(service.code,system?.name);
    const root=category(system?'信息化系统':path[0],null,index*10);
    let parent=root;
    if(system){
      const canonical=service.code==='INC-MAIL'?'企业邮箱':systemName(system.name);
      parent=add({id:id('system',system.id),parentId:root.id,kind:'SYSTEM',name:canonical,
        enabled:system.enabled,sortOrder:index*10,systemId:system.id,serviceCode:null});
    }else if(path[1])parent=category(path[1],root.id,index*10);
    else if(service.code==='INC-BIZ')parent=category('其他或不确定系统',root.id,index*10);
    const preferred=system&&service.code.startsWith('INC-')?'登录与使用故障':service.code==='INC-BIZ'?'业务系统故障待分类':service.name;
    add({id:id('service',service.code),parentId:parent.id,kind:'SERVICE',
      name:uniqueName(parent.id,preferred,service.code),enabled:parent.enabled,sortOrder:navigation.get(service.code)?.sortOrder??index*10,
      systemId:null,serviceCode:service.code});
  }
  const information=category('信息化系统',null,services.length*10);
  for(const name of applicationNames){
    const system=nodes.find(n=>n.kind==='SYSTEM'&&n.parentId===information.id&&n.name===name);
    const parent=system??(nodes.some(n=>n.parentId===information.id&&n.name===name)?null:
      add({id:id('system-draft',name),parentId:information.id,kind:'SYSTEM',name,enabled:false,
        sortOrder:nodes.length*10,systemId:null,serviceCode:null}));
    if(!parent)continue;
    for(const label of templates){
      if(nodes.some(n=>n.parentId===parent.id&&n.name===label))continue;
      add({id:id('draft',`${parent.id}:${label}`),parentId:parent.id,kind:'SERVICE',name:label,
        enabled:false,sortOrder:nodes.length*10,systemId:null,serviceCode:null});
    }
  }
  return nodes;
}
