import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import pg from 'pg';

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
  }
}finally{
  await db.query('ROLLBACK').catch(()=>{});
  await db.end();
}
