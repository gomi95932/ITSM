import type { CatalogItem } from '@itsm/contracts';

function contains(text:string,term:string):boolean {
  const value=term.trim().toLowerCase();
  if(value.length<2)return false;
  if(/^[a-z0-9 _-]+$/.test(value)) {
    const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`,'i').test(text);
  }
  return text.toLowerCase().includes(value);
}

// Suggestions use the caller's published catalog only; they never choose a person or execute a request.
export function voiceCandidate(text:string,catalog:CatalogItem[]) {
  const requested=/申请|开通|授权|权限|批准/.test(text);
  const ranked=catalog.filter(item=>item.available&&item.type===(requested?'REQ':'INC')).map(item=>{
    const fields:Record<string,string>={};let score=0;
    for(const field of item.fields) {
      const matches=(field.options??[]).filter(option=>contains(text,option));
      if(matches.length===1){fields[field.key]=matches[0];score+=4;}
    }
    if(contains(text,item.name))score+=6;
    const terms=new Set([...item.name.split(/[与、，,\/\s（）()]+/u),...item.description.matchAll(/[a-z][a-z0-9_-]{1,}/gi)].map(term=>typeof term==='string'?term:term[0]));
    if([...terms].some(term=>contains(text,term)))score+=2;
    return {item,fields,score};
  }).filter(result=>result.score>0).sort((a,b)=>b.score-a.score);
  const selected=ranked.length&&(!ranked[1]||ranked[0].score>ranked[1].score)?ranked[0]:undefined;
  return {serviceCode:selected?.item.code??null,subject:text.slice(0,80),description:text,fields:selected?.fields??{},
    missingFields:['impact','urgency',...(selected?selected.item.fields.filter(field=>field.required&&!selected.fields[field.key]).map(field=>field.key):['serviceCode']),
      ...(selected?.item.type==='REQ'?['requestedValidityDays']:[])],requiresReview:true,interpreter:'local-catalog'};
}
