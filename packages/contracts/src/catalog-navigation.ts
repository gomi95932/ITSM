export interface CatalogNavigationEntry {serviceCode:string;path:string[];sortOrder:number}
export interface CatalogTreeNode {
  id:string;parentId:string|null;kind:'CATEGORY'|'SYSTEM'|'SERVICE';name:string;
  enabled:boolean;sortOrder:number;systemId:string|null;serviceCode:string|null;
}
export interface CatalogNavigationSnapshot {
  treeVersion:number;leafId:string;serviceCode:string;systemId:string|null;
  path:{id:string;name:string;kind:CatalogTreeNode['kind']}[];
}
export interface CatalogTreeView {
  version:number;navigationVersion:number;structureVersion:number;nodes:CatalogTreeNode[];
  systems:{id:string;name:string;enabled:boolean}[];
  services:(CatalogNavigationView['services'][number]&{systemId:string|null;groupId:string;formVersion:number})[];
}
export function catalogTreePath(nodes:CatalogTreeNode[],code:string):CatalogTreeNode[]|null {
  const leaves=nodes.filter(n=>n.kind==='SERVICE'&&n.serviceCode===code);
  if(leaves.length!==1)return null;
  const byId=new Map(nodes.map(n=>[n.id,n])),path:CatalogTreeNode[]=[];
  let node:CatalogTreeNode|undefined=leaves[0];
  while(node){
    if(path.length>=3||path.some(p=>p.id===node!.id))return null;
    path.unshift(node);
    if(node.parentId===null)break;
    node=byId.get(node.parentId);if(!node)return null;
  }
  return path[0]?.kind==='CATEGORY'?path:null;
}
export function catalogTreeSnapshot(version:number,nodes:CatalogTreeNode[],code:string):CatalogNavigationSnapshot|null {
  const path=catalogTreePath(nodes,code);if(!path)return null;
  return {treeVersion:version,leafId:path.at(-1)!.id,serviceCode:code,
    systemId:path.find(n=>n.kind==='SYSTEM')?.systemId??null,
    path:path.map(({id,name,kind})=>({id,name,kind}))};
}
export interface CatalogNavigationView {
  version:number;
  items:CatalogNavigationEntry[];
  services:{code:string;name:string;published:boolean;mapped:boolean;staffed:boolean}[];
  history:{version:number;actorName:string|null;reason:string;createdAt:string}[];
}
