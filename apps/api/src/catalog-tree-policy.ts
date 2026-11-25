import {BadRequestException} from '@nestjs/common';
import {catalogTreePath,type CatalogTreeNode} from '@itsm/contracts';

const invalid=(code='INVALID_CATALOG_TREE'):never=>{throw new BadRequestException({code});};
export function catalogTreeInput(body:unknown){
  if(!body||typeof body!=='object'||Array.isArray(body))return invalid();
  const row=body as Record<string,unknown>;
  if(Object.keys(row).some(k=>!['expectedVersion','navigationVersion','structureVersion','nodes','reason','contentClass'].includes(k))
    ||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<0
    ||!Number.isSafeInteger(row.navigationVersion)||Number(row.navigationVersion)<1
    ||!Number.isSafeInteger(row.structureVersion)||Number(row.structureVersion)<1
    ||row.contentClass!=='GENERAL'||typeof row.reason!=='string'||!row.reason.trim()||row.reason.trim().length>500
    ||!Array.isArray(row.nodes)||row.nodes.length>2000)return invalid();
  const ids=new Set<string>(),codes=new Set<string>(),siblings=new Set<string>();
  const nodes:CatalogTreeNode[]=row.nodes.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
    const n=value as Record<string,unknown>;
    if(Object.keys(n).some(k=>!['id','parentId','kind','name','enabled','sortOrder','systemId','serviceCode'].includes(k))
      ||typeof n.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(n.id)||ids.has(n.id)
      ||!(n.parentId===null||typeof n.parentId==='string')
      ||!['CATEGORY','SYSTEM','SERVICE'].includes(String(n.kind))||typeof n.enabled!=='boolean'
      ||typeof n.name!=='string'||!n.name.trim()||n.name.trim().length>80||/[\u0000-\u001f\u007f]/.test(n.name)
      ||!Number.isSafeInteger(n.sortOrder)||Number(n.sortOrder)<0||Number(n.sortOrder)>99999
      ||!(n.systemId===null||typeof n.systemId==='string'&&n.systemId.length>0&&n.systemId.length<=100)
      ||!(n.serviceCode===null||typeof n.serviceCode==='string'&&n.serviceCode.length>0&&n.serviceCode.length<=100))return invalid();
    if(n.kind!=='SYSTEM'&&n.systemId!==null||n.kind!=='SERVICE'&&n.serviceCode!==null)return invalid();
    if(n.serviceCode!==null){if(codes.has(n.serviceCode as string))return invalid('CATALOG_TREE_DUPLICATE_SERVICE');codes.add(n.serviceCode as string);}
    const key=JSON.stringify([n.parentId,(n.name as string).trim().toLocaleLowerCase()]);
    if(siblings.has(key))return invalid('CATALOG_TREE_DUPLICATE_NAME');siblings.add(key);ids.add(n.id);
    return {...n,name:(n.name as string).trim()} as unknown as CatalogTreeNode;
  });
  const byId=new Map(nodes.map(n=>[n.id,n]));
  for(const n of nodes){
    const p=n.parentId?byId.get(n.parentId):undefined;
    if(n.kind==='CATEGORY'?(n.parentId!==null&&(!p||p.kind!=='CATEGORY'||p.parentId!==null)):(!p||p.kind==='SERVICE'))return invalid();
    if(n.kind==='SYSTEM'&&p?.kind!=='CATEGORY'||n.kind==='SERVICE'&&p?.kind!=='CATEGORY'&&p?.kind!=='SYSTEM')return invalid();
    if(n.kind==='SYSTEM'&&p?.parentId!==null)return invalid();
    if(p&&!p.enabled&&n.enabled)return invalid('CATALOG_TREE_DISABLED_ANCESTOR');
    if(n.kind==='SERVICE'&&n.serviceCode&&!catalogTreePath(nodes,n.serviceCode))return invalid();
    if(n.kind==='SYSTEM'&&n.enabled&&!n.systemId)return invalid('CATALOG_TREE_SYSTEM_REQUIRED');
    if(n.kind==='SERVICE'&&n.enabled&&!n.serviceCode)return invalid('CATALOG_TREE_SERVICE_REQUIRED');
  }
  const systems=new Set<string>();
  for(const node of nodes){
    if(node.kind==='SYSTEM'&&node.systemId){
      if(systems.has(node.systemId))return invalid('CATALOG_TREE_DUPLICATE_SYSTEM');
      systems.add(node.systemId);
    }
  }
  return {expectedVersion:row.expectedVersion as number,navigationVersion:row.navigationVersion as number,
    structureVersion:row.structureVersion as number,nodes,reason:row.reason.trim(),contentClass:'GENERAL' as const};
}
