import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dingtalkDirectory } from './directory-provider.js';
import { directoryEmployeeId,directoryScope,directorySettings } from './directory-sync.js';
const person=(id:string)=>({userid:id,name:`Person ${id}`,dept_id_list:[1,2],title:'Engineer',active:false});
const result=(value:unknown)=>({errcode:0,result:value});
const settings={roots:[1],token:async()=> 'fixture-only'};

test('directory enumerates child departments and all pages, deduplicating multi-department people',async()=>{
  const calls:string[]=[];
  const provider=dingtalkDirectory({...settings,transport:async(path,body)=>{
    const b=body as {dept_id:number;cursor:number};calls.push(`${path}:${b.dept_id}:${b.cursor??''}`);
    if(path.endsWith('listsub'))return result(b.dept_id===1?[{dept_id:2}]:[]);
    if(b.dept_id===1&&b.cursor===0)return result({list:[person('a')],has_more:true,next_cursor:100});
    return result({list:[person(b.dept_id===1?'b':'a')],has_more:false});
  }});
  const snapshot=await provider.snapshot(AbortSignal.timeout(1000));
  assert.equal(snapshot.departmentCount,2);assert.equal(snapshot.people.length,2);
  assert.equal(calls.length,5);
  assert.equal(snapshot.people[0].name,'Person a','DingTalk activation flag is not employment status');
});

test('incomplete pages, invalid identities, inconsistent snapshots and provider denial never return a snapshot',async()=>{
  for(const response of [result({list:[],has_more:true,next_cursor:0}),result({list:[{...person('a'),userid:''}],has_more:false}),
    result({list:[person('a')]}),{errcode:60011,result:[]},result({list:[{...person('a'),dept_id_list:[]}],has_more:false})]){
    const provider=dingtalkDirectory({...settings,transport:async path=>path.endsWith('listsub')?result([]):response});
    await assert.rejects(()=>provider.snapshot(AbortSignal.timeout(1000)),/DIRECTORY_PROVIDER_INVALID/);
  }
  const provider=dingtalkDirectory({...settings,transport:async(path,body)=>path.endsWith('listsub')?result([])
    :result({list:[{...person('a'),name:(body as {cursor:number}).cursor?'Changed':'First'}],has_more:(body as {cursor:number}).cursor===0,next_cursor:1})});
  await assert.rejects(()=>provider.snapshot(AbortSignal.timeout(1000)),/DIRECTORY_SNAPSHOT_CHANGED/);
});

test('empty snapshots and invalid roots fail closed',async()=>{
  assert.throws(()=>dingtalkDirectory({...settings,roots:[]}),/DIRECTORY_SCOPE_INVALID/);
  assert.throws(()=>dingtalkDirectory({...settings,roots:[1,1]}),/DIRECTORY_SCOPE_INVALID/);
  const provider=dingtalkDirectory({...settings,transport:async path=>path.endsWith('listsub')?result([]):result({list:[],has_more:false})});
  await assert.rejects(()=>provider.snapshot(AbortSignal.timeout(1000)),/DIRECTORY_EMPTY_SNAPSHOT/);
});

test('configuration requires explicit scope and stable opaque IDs never depend on names',()=>{
  assert.equal(directorySettings({}),undefined);
  assert.throws(()=>directorySettings({ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture'}),/DIRECTORY_CONFIG_INVALID/);
  const config=directorySettings({ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture',DINGTALK_DIRECTORY_ROOTS:'2,1'})!;
  assert.equal(config.retireMissing,false);
  assert.equal(directoryScope(config),directoryScope({...config,roots:[1,2]}));
  assert.notEqual(directoryEmployeeId('first','same'),directoryEmployeeId('second','same'));
  assert.throws(()=>directorySettings({ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture',DINGTALK_DIRECTORY_ROOTS:'1',DIRECTORY_MAX_REMOVAL_PERCENT:'NaN'}));
  assert.throws(()=>directorySettings({ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture',DINGTALK_DIRECTORY_ROOTS:'1',DIRECTORY_MAX_REMOVAL_PERCENT:' '}));
});
