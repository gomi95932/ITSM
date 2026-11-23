import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { ownershipCandidatesQuery } from '../../apps/worker/dist/ownership-query.js';
import { recoverOwnership } from '../../apps/worker/dist/ownership-recovery.js';

if(process.env.GITHUB_ACTIONS!=='true'||process.env.DB_HOST!=='127.0.0.1'||process.env.ITSM_SEED_DEV_DATA!=='true')
  throw new Error('DISPOSABLE_AUTHORIZATION_CI_ONLY');
const db=new pg.Client({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,statement_timeout:30000});
await db.connect();
try{
  await db.query('BEGIN');
  const config={domains:[{id:'performance-domain',name:'CI',enabled:true}],systems:[],
    positions:[{id:'performance-position',name:'CI',domainId:'performance-domain',groupId:'service-desk',enabled:true}],
    appointments:[{id:'performance-appointment',positionId:'performance-position',employeeId:'agent-1',duty:'PRIMARY',
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:null,enabled:true}],mappings:[]};
  await db.query('INSERT INTO service_structure_versions(version,config) VALUES(2,$1)',[JSON.stringify(config)]);
  await db.query('UPDATE service_structure_current SET version=2 WHERE id');
  const snapshot={positions:[{id:'performance-position',groupId:'service-desk'}]};
  await db.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,
    form_version,subject,description,fields,impact,urgency,priority,status,assignee_id,service_routing_snapshot)
    SELECT gen_random_uuid(),'PERFORMANCE-'||n,'employee-1','employee-1','service-desk','INC-PC','INC',
      1,'Isolated performance fixture','CI-only fixture','{}','INDIVIDUAL','MEDIUM','P3','IN_PROGRESS','agent-1',$1
    FROM generate_series(1,200) n`,[JSON.stringify(snapshot)]);
  const body=(await db.query("SELECT prosrc FROM pg_proc WHERE oid='service_position_eligible(jsonb,text,text)'::regprocedure")).rows[0].prosrc;
  // Explain the SQL function body too: EXPLAIN on a volatile function hides its nested plan.
  const sql=body.replace(/\bsnapshot\b/g,'$1::jsonb').replace(/\bemployee\b/g,'$2::text').replace(/\btarget_group\b/g,'$3::text');
  for(const jit of ['on','off']){
    await db.query(`SET LOCAL jit=${jit}`);
    const plan=(await db.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${sql}`,[JSON.stringify(snapshot),'agent-1','service-desk'])).rows[0]['QUERY PLAN'][0];
    const start=performance.now();
    for(let i=0;i<5;i++)assert.equal((await db.query('SELECT service_position_eligible($1,$2,$3) AS eligible',
      [JSON.stringify(snapshot),'agent-1','service-desk'])).rows[0].eligible,true);
    console.log(JSON.stringify({jit,executionMs:plan['Execution Time'],planningMs:plan['Planning Time'],
      compilation:plan.JIT,estimatedCost:plan.Plan['Total Cost'],fiveChecksMs:performance.now()-start}));
    const scan=(await db.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${ownershipCandidatesQuery}`)).rows[0]['QUERY PLAN'][0];
    console.log(JSON.stringify({operation:'ownership-scan',jit,executionMs:scan['Execution Time'],
      planningMs:scan['Planning Time'],compilation:scan.JIT,estimatedCost:scan.Plan['Total Cost']}));
    assert.ok(scan['Execution Time']<1000,'candidate selection must not evaluate eligibility for the entire backlog');
  }
  const eligible=async(routing=snapshot)=>(await db.query('SELECT service_position_eligible($1,$2,$3) AS eligible',
    [JSON.stringify(routing),'agent-1','service-desk'])).rows[0].eligible;
  const term=async patch=>{
    const next=structuredClone(config);Object.assign(next.appointments[0],patch);
    const result=await db.query('INSERT INTO service_structure_versions(version,config) SELECT max(version)+1,$1 FROM service_structure_versions RETURNING version',[JSON.stringify(next)]);
    await db.query('UPDATE service_structure_current SET version=$1 WHERE id',[result.rows[0].version]);
  };
  await term({validFrom:new Date(Date.now()+86400000).toISOString()});assert.equal(await eligible(),false,'future permanent appointment is not active');
  await term({validTo:new Date(Date.now()-1000).toISOString()});assert.equal(await eligible(),false,'expired fixed appointment is not active');
  await term({enabled:false});assert.equal(await eligible(),false,'permanent appointment can be revoked');
  await term({});assert.equal(await eligible(),true);
  await db.query("UPDATE employees SET active=false WHERE id='agent-1'");assert.equal(await eligible(),false,'permanent appointment does not bypass employee retirement');
  await db.query("UPDATE employees SET active=true WHERE id='agent-1'");
  await db.query("DELETE FROM group_memberships WHERE employee_id='agent-1' AND group_id='service-desk'");
  assert.equal(await eligible(),false,'permanent appointment does not bypass group membership');
  await db.query("INSERT INTO group_memberships(employee_id,group_id) VALUES('agent-1','service-desk')");
  const operations=(await db.query('SELECT config FROM operations_current')).rows[0].config;
  const siteConfig={...operations,siteEnforced:true,sites:[{id:'test-site',enabled:true}],
    employeeSites:[{employeeId:'agent-1',siteIds:['test-site']}],groupSites:[{groupId:'service-desk',siteIds:['test-site']}],
    positionSites:[{positionId:'performance-position',siteIds:['test-site']}]};
  await db.query('INSERT INTO operations_versions(version,config) SELECT max(version)+1,$1 FROM operations_versions',[JSON.stringify(siteConfig)]);
  assert.equal(await eligible(),false,'site enforcement still requires a ticket site');
  assert.equal(await eligible({...snapshot,site:{id:'test-site'}}),true);
  assert.equal(await eligible({...snapshot,site:{id:'other-site'}}),false,'permanent appointment cannot cross sites');
  await db.query('INSERT INTO operations_versions(version,config) SELECT max(version)+1,$1 FROM operations_versions',
    [JSON.stringify({...siteConfig,positionSites:[]})]);
  assert.equal(await eligible({...snapshot,site:{id:'test-site'}}),false,'position site restrictions remain enforced');
}finally{
  await db.query('ROLLBACK').catch(()=>{});
  await db.end();
}

// The database belongs only to this job; committed fixtures let independent
// connections prove real lock scheduling and visibility after revocation.
const pool=new pg.Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),database:process.env.DB_NAME,
  user:process.env.DB_USER,password:process.env.DB_PASSWORD,max:6,statement_timeout:10000});
let releaseFirst;
const firstMayContinue=new Promise(resolve=>{releaseFirst=resolve;});
let markFirst;
const firstUpdated=new Promise(resolve=>{markFirst=resolve;});
let firstId,recovery,writer,writerPending;
try{
  const config={domains:[{id:'fairness-domain',name:'CI',enabled:true}],systems:[],
    positions:[{id:'fairness-position',name:'CI',domainId:'fairness-domain',groupId:'service-desk',enabled:true}],
    appointments:[{id:'fairness-appointment',positionId:'fairness-position',employeeId:'agent-1',duty:'PRIMARY',
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:null,enabled:true}],mappings:[]};
  await pool.query('INSERT INTO service_structure_versions(version,config) VALUES(2,$1)',[JSON.stringify(config)]);
  await pool.query('UPDATE service_structure_current SET version=2 WHERE id');
  const fixture=await pool.query(`INSERT INTO tickets(id,number,requester_id,submitted_by_id,owner_group_id,service_code,service_type,
    form_version,subject,description,fields,impact,urgency,priority,status,assignee_id,service_routing_snapshot)
    SELECT gen_random_uuid(),'FAIRNESS-'||n,'employee-1','employee-1','service-desk','INC-PC','INC',
      1,'Isolated fairness fixture','CI-only fixture','{}','INDIVIDUAL','MEDIUM','P3','IN_PROGRESS','agent-1',$1
    FROM generate_series(1,200) n RETURNING id`,[JSON.stringify({positions:[{id:'fairness-position',groupId:'service-desk'}]})]);
  const ids=fixture.rows.map(row=>row.id);
  let recovered=0;
  const record=async(_client,_row,action)=>{if(action==='OWNERSHIP_RECOVERED')recovered++;};
  const observedPool={query:(...args)=>pool.query(...args),connect:async()=>{
    const client=await pool.connect();
    return {release:()=>client.release(),query:async(...args)=>{
      const result=await client.query(...args);
      if(!firstId&&typeof args[0]==='string'&&args[0].startsWith('UPDATE tickets SET ownership_checked_at=')){
        firstId=args[1][0];markFirst();await firstMayContinue;
      }
      return result;
    }};
  }};
  recovery=recoverOwnership(observedPool,record);
  await Promise.race([firstUpdated,recovery.then(()=>{throw new Error('FIRST_OWNERSHIP_CHECK_NOT_OBSERVED');})]);
  writer=await pool.connect();
  await writer.query('BEGIN');
  await writer.query("SET LOCAL lock_timeout='2s'");
  const pid=(await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  writerPending=writer.query('SELECT pg_advisory_xact_lock(71820512)');
  writerPending.catch(()=>{});
  let waiting=false;
  for(let i=0;i<100&&!waiting;i++){
    waiting=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0].waiting;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waiting,true,'authorization writer must actually queue behind the first ticket');
  releaseFirst();
  await writerPending;
  const checked=(await writer.query('SELECT count(*)::integer AS count FROM tickets WHERE id=ANY($1::uuid[]) AND ownership_checked_at IS NOT NULL',[ids])).rows[0].count;
  assert.equal(checked,1,'authorization changes must proceed between tickets, rather than wait for the whole batch');
  await writer.query("UPDATE employees SET active=false WHERE id='agent-1'");
  await writer.query('COMMIT');
  await recovery;
  assert.equal(recovered,99,'later tickets must re-read the employee revocation committed by the writer');
  await recoverOwnership(pool,record);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM tickets WHERE id=ANY($1::uuid[]) AND ownership_checked_at IS NOT NULL',[ids])).rows[0].count,200,
    'the second batch must reach every previously unchecked ticket');
  assert.equal(recovered,199);
  await recoverOwnership(pool,record);
  assert.equal(recovered,200,'a previously checked ticket must be revisited after the backlog rotates');
  const first=(await pool.query('SELECT assignee_id,status,version FROM tickets WHERE id=$1',[firstId])).rows[0];
  assert.equal(first.assignee_id,null);assert.equal(first.status,'IN_PROGRESS');assert.equal(first.version,2);
  console.log(JSON.stringify({operation:'ownership-fairness',tickets:200,checksBeforeWriter:checked,recovered,status:'passed'}));
}finally{
  releaseFirst();
  if(writer){await writerPending?.catch(()=>{});await writer.query('ROLLBACK').catch(()=>{});writer.release();}
  await recovery?.catch(()=>{});
  await pool.end();
}
