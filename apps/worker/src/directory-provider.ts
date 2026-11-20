export type DirectoryPerson = { userId:string; name:string; departmentIds:number[]; jobTitle:string };
export type DirectorySnapshot = { people:DirectoryPerson[]; departmentCount:number };
export type DirectoryProvider = { snapshot(signal:AbortSignal):Promise<DirectorySnapshot> };
type Transport=(path:string,body:object,signal:AbortSignal)=>Promise<unknown>;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max=200):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max;
const department=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
function invalid():never{throw new Error('DIRECTORY_PROVIDER_INVALID');}

// A snapshot is returned only after every department and every user page has completed.
export function dingtalkDirectory(settings:{roots:readonly number[];token:(signal:AbortSignal)=>Promise<string>;transport?:Transport}):DirectoryProvider {
  if(!settings.roots.length||!settings.roots.every(department)||new Set(settings.roots).size!==settings.roots.length)
    throw new Error('DIRECTORY_SCOPE_INVALID');
  const transport:Transport=settings.transport??(async(path,body,signal)=>{
    const token=await settings.token(signal);
    if(!text(token,4096))throw new Error('DIRECTORY_TOKEN_UNAVAILABLE');
    const response=await fetch(`https://oapi.dingtalk.com${path}?access_token=${encodeURIComponent(token)}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal,redirect:'error',
    });
    if(!response.ok)throw new Error('DIRECTORY_PROVIDER_UNAVAILABLE');
    return response.json();
  });
  const call=async(path:string,body:object,signal:AbortSignal)=>{
    const data=await transport(path,body,signal);
    if(!object(data)||data.errcode!==0||!('result' in data))invalid();
    return data.result;
  };
  return {async snapshot(signal){
    const pending=[...settings.roots],visited=new Set<number>();
    const people=new Map<string,DirectoryPerson>();
    while(pending.length){
      signal.throwIfAborted();
      const id=pending.shift()!;
      if(visited.has(id))continue;
      if(visited.size>=2000)throw new Error('DIRECTORY_SCOPE_TOO_LARGE');
      visited.add(id);
      const children=await call('/topapi/v2/department/listsub',{dept_id:id},signal);
      if(!Array.isArray(children))invalid();
      for(const child of children){
        if(!object(child)||!department(child.dept_id))invalid();
        if(!visited.has(child.dept_id))pending.push(child.dept_id);
      }
      let cursor=0,finished=false;
      const cursors=new Set<number>();
      for(let page=0;page<1000;page++){
        if(cursors.has(cursor))invalid();cursors.add(cursor);
        const result=await call('/topapi/v2/user/list',{dept_id:id,cursor,size:100},signal);
        if(!object(result)||!Array.isArray(result.list)||typeof result.has_more!=='boolean')invalid();
        for(const item of result.list){
          if(!object(item)||!text(item.userid)||!text(item.name)||!Array.isArray(item.dept_id_list)
            ||!item.dept_id_list.length||!item.dept_id_list.every(department)
            ||(item.title!==undefined&&(typeof item.title!=='string'||item.title.length>200)))invalid();
          const person:DirectoryPerson={userId:item.userid,name:item.name.trim(),
            departmentIds:[...new Set(item.dept_id_list as number[])].sort((a,b)=>a-b),jobTitle:typeof item.title==='string'?item.title:''};
          const previous=people.get(person.userId);
          if(previous&&JSON.stringify(previous)!==JSON.stringify(person))throw new Error('DIRECTORY_SNAPSHOT_CHANGED');
          people.set(person.userId,person);
          if(people.size>20000)throw new Error('DIRECTORY_SCOPE_TOO_LARGE');
        }
        if(!result.has_more){finished=true;break;}
        if(!Number.isSafeInteger(result.next_cursor)||(result.next_cursor as number)<=cursor)invalid();
        cursor=result.next_cursor as number;
      }
      if(!finished)invalid();
    }
    if(!people.size)throw new Error('DIRECTORY_EMPTY_SNAPSHOT');
    return {people:[...people.values()],departmentCount:visited.size};
  }};
}
