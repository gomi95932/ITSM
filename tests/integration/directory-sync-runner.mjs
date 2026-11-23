import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { Pool } from 'pg';
import { synchronizeDirectory,directoryEmployeeId,directorySettings } from './apps/worker/dist/directory-sync.js';

if(process.env.ITSM_DIRECTORY_CI!=='true'||process.env.NODE_ENV==='production'
  ||process.env.ENABLE_DIRECTORY_SYNC==='true')throw new Error('DISPOSABLE_DIRECTORY_CI_ONLY');
const db=new Pool({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:5});
const corp=`directory-ci-${randomUUID()}`,legacy=`${corp}-legacy`,manual=`${corp}-manual`,other=`${corp}-other`;
const settings={corpId:corp,roots:[1],retireMissing:false,maxRemovalPercent:100};
const person=id=>({userId:id,name:`Fixture ${id}`,departmentIds:[1],jobTitle:'Engineer'});
const provider=ids=>({snapshot:async()=>({people:ids.map(person),departmentCount:1})});
const sync=(ids,config={})=>synchronizeDirectory(db,{...settings,...config},provider(ids));
const employee=id=>directoryEmployeeId(corp,id);
const row=async(id)=>(await db.query('SELECT * FROM employees WHERE id=$1',[id])).rows[0];
const absence=async(id)=>(await db.query('SELECT consecutive_absences FROM directory_people WHERE corp_id=$1 AND ding_user_id=$2',[corp,id])).rows[0].consecutive_absences;
const run=async()=>(await db.query('SELECT * FROM directory_sync_runs WHERE corp_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1',[corp])).rows[0];
async function session(id){
  const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
  await db.query(`INSERT INTO auth_sessions(token_hash,csrf_token,employee_id,expires_at) VALUES($1,'fixture-csrf',$2,now()+interval '1 hour')`,[hash,id]);
  return {hash,cookie:`itsm_session=${token}`};
}
async function request(path,headers={}){
  const response=await fetch(`http://api:3000/api/v1${path}`,{headers,signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json()};
}
const all=['a','b','legacy','manual'];
try{
  await db.query('INSERT INTO employees(id,display_name,active) VALUES($1,$1,true),($2,$2,false),($3,$3,true)',[legacy,manual,other]);
  await db.query(`INSERT INTO identity_links(corp_id,ding_user_id,employee_id) VALUES($1,'legacy',$2),($1,'manual',$3)`,[corp,legacy,manual]);
  const kept=await session(legacy);
  const first=await sync(all);assert.equal(first.state,'SUCCEEDED');assert.equal(first.created,2);
  assert.equal((await row(legacy)).display_name,'Fixture legacy','existing employee mapping is reused');
  assert.equal((await row(manual)).active,false,'manual inactive employee is not reactivated');
  assert.equal((await request('/auth/me',{cookie:kept.cookie})).body.id,legacy,'unchanged identity preserves sessions');
  for(const table of ['group_memberships','role_bindings']){
    assert.equal((await db.query(`SELECT count(*) FROM ${table} WHERE employee_id=ANY($1::text[])`,[[employee('a'),employee('b')]])).rows[0].count,'0','directory titles do not grant roles or appointments');
  }
  assert.equal((await sync(all)).created,0,'repeat snapshot does not duplicate employees');

  const failed=await synchronizeDirectory(db,settings,{snapshot:async()=>{throw new Error('upstream response contains private fixture');}});
  assert.equal(failed.state,'FAILED');assert.equal((await run()).error_code,'DIRECTORY_SYNC_FAILED');
  assert.equal(await absence('a'),0,'partial provider failure does not count as absence');
  assert.equal((await row(employee('a'))).active,true);
  const empty=await sync([]);assert.equal(empty.errorCode,'DIRECTORY_EMPTY_SNAPSHOT');
  const duplicate=await sync(['a','a']);assert.equal(duplicate.errorCode,'DIRECTORY_SNAPSHOT_CHANGED');
  assert.equal(await absence('b'),0);

  const aSession=await session(employee('a'));
  let result=await sync(['b','legacy','manual']);assert.equal(result.disabled,0);
  result=await sync(['b','legacy','manual']);assert.equal(result.disabled,0,'retirement is opt-in');
  assert.equal((await row(employee('a'))).active,true);
  await sync(all);assert.equal(await absence('a'),0);
  result=await sync(['b','legacy','manual'],{retireMissing:true});assert.equal(result.disabled,0,'first absence never retires');
  assert.equal((await request('/auth/me',{cookie:aSession.cookie})).status,200);
  result=await sync(['b','legacy','manual'],{retireMissing:true});assert.equal(result.disabled,1);
  assert.equal((await row(employee('a'))).active,false);
  assert.equal((await request('/auth/me',{cookie:aSession.cookie})).status,401,'retirement immediately revokes live sessions');
  assert.equal((await request('/auth/me',{cookie:kept.cookie})).status,200,'other employee sessions survive retirement');
  await sync(all);assert.equal((await row(employee('a'))).active,false,'returning identity requires explicit reactivation');
  assert.equal((await request('/auth/me',{cookie:aSession.cookie})).status,401);

  await db.query('UPDATE employees SET active=true WHERE id=$1',[employee('a')]);
  await sync(all);
  await sync(['legacy','manual'],{retireMissing:true});
  const beforeA=await absence('a'),beforeB=await absence('b');
  result=await sync(['legacy','manual'],{retireMissing:true,maxRemovalPercent:10});
  assert.equal(result.errorCode,'DIRECTORY_REMOVAL_LIMIT');
  assert.equal(await absence('a'),beforeA);assert.equal(await absence('b'),beforeB,'mass-removal failure rolls back all changes');
  assert.equal((await row(employee('b'))).active,true);
  assert.equal((await run()).state,'FAILED');
  await sync(all);

  await sync(['a'],{roots:[2],retireMissing:true});
  await sync(['a'],{roots:[2],retireMissing:true});
  assert.equal(await absence('b'),0,'scope changes do not silently retire people from old scope');
  assert.equal((await row(employee('b'))).active,true);
  await sync(all);

  await db.query(`UPDATE identity_links SET employee_id=$2 WHERE corp_id=$1 AND ding_user_id='a'`,[corp,other]);
  result=await sync(['new-before-conflict',...all]);assert.equal(result.errorCode,'DIRECTORY_IDENTITY_CONFLICT');
  assert.equal(await row(employee('new-before-conflict')),undefined,'identity conflict rolls back earlier inserts');
  await db.query(`UPDATE identity_links SET employee_id=$2 WHERE corp_id=$1 AND ding_user_id='a'`,[corp,employee('a')]);

  result=await sync([...all,'pilot-new','outside-pilot'],{pilotUserIds:['pilot-new']});
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.people,1);
  assert.ok(await row(employee('pilot-new')));
  assert.equal(await row(employee('outside-pilot')),undefined,'department peers outside the pilot are never imported');
  const pilotSnapshot=JSON.stringify(await row(employee('pilot-new')));
  result=await sync([...all,'pilot-new','new-before-missing'],{pilotUserIds:['pilot-new','missing','new-before-missing']});
  assert.equal(result.errorCode,'DIRECTORY_PILOT_PERSON_MISSING');
  assert.equal(await row(employee('new-before-missing')),undefined,'incomplete pilot fails before any insert');
  assert.equal(JSON.stringify(await row(employee('pilot-new'))),pilotSnapshot);
  assert.equal(await absence('b'),0,'narrowing the scope never retires prior department peers');

  const authorized=directorySettings({ENABLE_DIRECTORY_SYNC:'true',DINGTALK_CORP_ID:corp,DINGTALK_DIRECTORY_ROOTS:'1',
    DINGTALK_PILOT_USER_IDS:'pilot-new',DINGTALK_DIRECTORY_SCOPE:'authorized'});
  result=await synchronizeDirectory(db,authorized,provider([...all,'pilot-new','outside-pilot']));
  assert.equal(result.state,'SUCCEEDED');assert.equal(result.people,6);
  assert.ok(await row(employee('outside-pilot')),'authorized directory imports employees outside notification pilot');
  for(const table of ['group_memberships','role_bindings']){
    assert.equal((await db.query(`SELECT count(*) FROM ${table} WHERE employee_id=$1`,[employee('outside-pilot')])).rows[0].count,'0');
  }

  const locker=await db.connect();
  try{
    await locker.query('SELECT pg_advisory_lock(71820535)');
    result=await synchronizeDirectory(db,settings,{snapshot:async()=>{throw new Error('must not fetch while busy');}});
    assert.equal(result.state,'BUSY','concurrent workers cannot apply competing directory snapshots');
  }finally{await locker.query('SELECT pg_advisory_unlock(71820535)');locker.release();}

  assert.equal((await request('/admin/directory/status')).status,401);
  assert.equal((await request('/admin/directory/status',{'x-dev-user':'employee-1'})).status,403);
  assert.equal((await request('/admin/directory/status',{'x-dev-user':'agent-1'})).status,403,'dispatcher cannot read directory admin ledger');
  const admin=await request('/admin/directory/status',{'x-dev-user':'demo-admin-1'});
  assert.equal(admin.status,200);assert.equal(admin.body.enabled,false);
  assert.equal(admin.body.scopeMode,'pilot');
  assert.ok(!JSON.stringify(admin.body).includes('DB_PASSWORD'));
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    await client.query("UPDATE role_bindings SET valid_to=clock_timestamp()-interval '1 minute',valid_from=clock_timestamp()-interval '2 minutes' WHERE employee_id='demo-admin-1' AND role_code='PLATFORM_ADMIN'");
    await client.query('COMMIT');
    assert.equal((await request('/admin/directory/status',{'x-dev-user':'demo-admin-1'})).status,403,'expired administrator cannot read synchronization records');
  }finally{
    await client.query("UPDATE role_bindings SET valid_from=now(),valid_to=now()+interval '365 days' WHERE employee_id='demo-admin-1' AND role_code='PLATFORM_ADMIN'");
    client.release();
  }
  console.log('Directory synchronization verified: stable identity, no privilege grant, session preservation/revocation, opt-in retirement, reactivation, failure atomicity, scope changes, removal limit, identity conflicts, worker concurrency and API authorization');
}finally{
  const ids=[legacy,manual,other,...['a','b','new-before-conflict','pilot-new','outside-pilot','new-before-missing'].map(employee)];
  await db.query('DELETE FROM directory_people WHERE corp_id=$1',[corp]);
  await db.query('DELETE FROM directory_sync_runs WHERE corp_id=$1',[corp]);
  await db.query('DELETE FROM identity_links WHERE corp_id=$1',[corp]);
  await db.query('DELETE FROM auth_sessions WHERE employee_id=ANY($1::text[])',[ids]);
  await db.query('DELETE FROM employees WHERE id=ANY($1::text[])',[ids]);
  await db.end();
}
