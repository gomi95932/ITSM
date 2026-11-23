import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dingtalkDirectory } from './directory-provider.js';
import { directoryEmployeeId,directoryScope,directorySettings,restrictDirectory } from './directory-sync.js';
import { dingtalkPilotUsers } from './dingtalk-pilot.js';
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

test('temporary directory timeouts retry while permission errors fail immediately',async()=>{
  let calls=0;
  const provider=dingtalkDirectory({...settings,transport:async path=>{
    if(path.endsWith('listsub')&&calls++===0)return {errcode:88,errmsg:'ding talk error'};
    return path.endsWith('listsub')?result([]):result({list:[person('a')],has_more:false});
  }});
  assert.equal((await provider.snapshot(AbortSignal.timeout(3000))).people.length,1);
  assert.equal(calls,2);
  for(const denial of [{errcode:88,sub_code:'60011'},{errcode:88,errmsg:'ding talk error[subcode=60011,submsg=denied]'}]){
    let deniedCalls=0;
    const denied=dingtalkDirectory({...settings,transport:async()=>{deniedCalls++;return denial;}});
    await assert.rejects(()=>denied.snapshot(AbortSignal.timeout(1000)),/DIRECTORY_PROVIDER_INVALID/);
    assert.equal(deniedCalls,1);
  }
  let failures=0;
  const unavailable=dingtalkDirectory({...settings,transport:async()=>{failures++;return {errcode:15};}});
  await assert.rejects(()=>unavailable.snapshot(AbortSignal.timeout(3000)),/DIRECTORY_PROVIDER_TRANSIENT/);
  assert.equal(failures,3);
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
test('pilot scope requires exact unique identities and changes directory scope without changing legacy scope',()=>{
  assert.equal(dingtalkPilotUsers({}),undefined);assert.equal(dingtalkPilotUsers({DINGTALK_PILOT_USER_IDS:''}),undefined);
  assert.deepEqual(dingtalkPilotUsers({DINGTALK_PILOT_USER_IDS:'pilot-a, pilot-b'}),['pilot-a','pilot-b']);
  for(const raw of [' ', 'a,', 'a,a','a\nb',Array.from({length:31},(_,i)=>`person-${i}`).join(',')])
    assert.throws(()=>dingtalkPilotUsers({DINGTALK_PILOT_USER_IDS:raw}),/DINGTALK_PILOT_CONFIG_INVALID/);
  const config=directorySettings({ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture',DINGTALK_DIRECTORY_ROOTS:'1',DINGTALK_PILOT_USER_IDS:'a,b'})!;
  assert.deepEqual(config.pilotUserIds,['a','b']);
  assert.equal(directoryScope(config),directoryScope({...config,pilotUserIds:['b','a']}));
  assert.notEqual(directoryScope(config),directoryScope({...config,pilotUserIds:undefined}));
  assert.notEqual(directoryScope(config),directoryScope({...config,pilotUserIds:['a']}));
  const snapshot={people:['a','b','outside'].map(userId=>({userId,name:userId,departmentIds:[1],jobTitle:''})),departmentCount:1};
  assert.deepEqual(restrictDirectory(snapshot,['a','b']).people.map(p=>p.userId),['a','b']);
  assert.equal(snapshot.people.length,3,'filter does not mutate the provider snapshot');
  assert.throws(()=>restrictDirectory(snapshot,['a','missing']),/DIRECTORY_PILOT_PERSON_MISSING/);
  assert.throws(()=>restrictDirectory(snapshot,[]),/DIRECTORY_PILOT_PERSON_MISSING/);
});

test('authorized directory scope imports non-pilot people without expanding notification pilot recipients',()=>{
  const env={ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:'fixture',DINGTALK_DIRECTORY_ROOTS:'1',
    DINGTALK_PILOT_USER_IDS:'a,b',DINGTALK_DIRECTORY_SCOPE:'authorized'};
  const config=directorySettings(env)!;
  assert.equal(config.pilotUserIds,undefined);
  assert.equal(config.timeoutMs,900000);
  const snapshot={people:['a','b','other'].map(userId=>({userId,name:userId,departmentIds:[1],jobTitle:''})),departmentCount:1};
  assert.equal(restrictDirectory(snapshot,config.pilotUserIds).people.length,3);
  assert.deepEqual(dingtalkPilotUsers(env),['a','b']);
  assert.equal(config.retireMissing,false);
  assert.notEqual(directoryScope(config),directoryScope({...config,pilotUserIds:['a','b']}));
  assert.throws(()=>directorySettings({...env,DINGTALK_DIRECTORY_SCOPE:'alll'}),/DIRECTORY_CONFIG_INVALID/);
});
