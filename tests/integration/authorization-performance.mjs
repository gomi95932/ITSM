import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { ownershipCandidatesQuery } from '../../apps/worker/dist/ownership-query.js';

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
      validFrom:new Date(Date.now()-60000).toISOString(),validTo:new Date(Date.now()+86400000).toISOString(),enabled:true}],mappings:[]};
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
  }
}finally{
  await db.query('ROLLBACK').catch(()=>{});
  await db.end();
}
