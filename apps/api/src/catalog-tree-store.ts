import {BadRequestException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {catalogTreePath,catalogTreeSnapshot,type CatalogTreeNode} from '@itsm/contracts';

type Client=Pick<PoolClient,'query'>;
export type CurrentCatalogTree={version:number;nodes:CatalogTreeNode[]};
export async function currentCatalogTree(client:Client):Promise<CurrentCatalogTree|null>{
  return (await client.query<CurrentCatalogTree>('SELECT version,nodes FROM catalog_tree_versions ORDER BY version DESC LIMIT 1')).rows[0]??null;
}
export function directoryState(tree:CurrentCatalogTree|null,code:string,systemId:string|null):{
  navigation:ReturnType<typeof catalogTreeSnapshot>;
  reason:'DIRECTORY_UNASSIGNED'|'DIRECTORY_DISABLED'|'SYSTEM_MAPPING_MISMATCH'|undefined;
}{
  if(!tree)return {navigation:null,reason:undefined};
  const path=catalogTreePath(tree.nodes,code),navigation=catalogTreeSnapshot(tree.version,tree.nodes,code);
  const reason=!path?'DIRECTORY_UNASSIGNED':path.some(n=>!n.enabled)?'DIRECTORY_DISABLED':
    (path.find(n=>n.kind==='SYSTEM')?.systemId??null)!==(systemId??null)?'SYSTEM_MAPPING_MISMATCH':undefined;
  return {navigation,reason};
}
export async function requireDirectoryService(client:Client,code:string,systemId:string|null){
  const state=directoryState(await currentCatalogTree(client),code,systemId);
  if(state.reason)throw new BadRequestException({code:state.reason});
  return state.navigation;
}
