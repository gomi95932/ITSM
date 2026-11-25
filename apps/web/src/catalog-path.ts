import type {CatalogItem} from '@itsm/contracts';
export const categoryId=(item:CatalogItem)=>item.navigation?.path[0]?.id??item.navigationPath?.[0]??'';
export const categoryName=(item:CatalogItem)=>item.navigation?.path[0]?.name??item.navigationPath?.[0]??'待配置目录';
export const systemId=(item:CatalogItem)=>item.navigation?.path[1]?.id??(!item.navigation?item.navigationPath?.[1]??'':'');
export const systemName=(item:CatalogItem)=>item.navigation?.path[1]?.name??(!item.navigation?item.navigationPath?.[1]??'':'');
