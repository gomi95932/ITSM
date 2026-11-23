export interface CatalogNavigationEntry {serviceCode:string;path:string[];sortOrder:number}
export interface CatalogNavigationView {
  version:number;
  items:CatalogNavigationEntry[];
  services:{code:string;name:string;published:boolean;mapped:boolean;staffed:boolean}[];
  history:{version:number;actorName:string|null;reason:string;createdAt:string}[];
}
