import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';

const source=process.cwd();
const allowed=new Set(['catalog-classification-handover','catalog-navigation','automatic-dispatch']);
const selected=process.argv.slice(2);
assert.ok(selected.every(name=>allowed.has(name)),'Only catalog regression suites are permitted');
const root=`${homedir()}/itsm-checks/catalog-disposable-${randomUUID()}`;
const pg=process.env.ITSM_TEST_POSTGRES_BIN??'/usr/lib/postgresql/16/bin';
const port=55000+Math.floor(Math.random()*4000);
const password=randomBytes(24).toString('hex');
const env={...process.env,DB_HOST:'127.0.0.1',DB_PORT:String(port),DB_NAME:'postgres',DB_USER:process.env.USER,
  DB_PASSWORD:password,ITSM_SEED_DEV_DATA:'true',NODE_ENV:'test',ENABLE_LIVE_NOTIFICATIONS:'false',
  ENABLE_DIRECTORY_SYNC:'false',ENABLE_LIVE_OA_APPROVAL:'false'};
function run(command,args,timeout=120000){
  const result=spawnSync(command,args,{cwd:source,env,encoding:'utf8',timeout});
  assert.equal(result.status,0,result.stderr||result.stdout||`${command} exited ${result.status}`);
  return result.stdout;
}
await mkdir(`${root}/socket`,{recursive:true,mode:0o700});
await writeFile(`${root}/password`,password,{mode:0o600});
let started=false;
try{
  run(`${pg}/initdb`,['-D',`${root}/data`,'--auth=scram-sha-256','--pwfile',`${root}/password`,'--no-locale','--encoding=UTF8']);
  run(`${pg}/pg_ctl`,['-D',`${root}/data`,'-l',`${root}/postgres.log`,
    '-o',`-h 127.0.0.1 -p ${port} -k ${root}/socket`,'-w','start']);
  started=true;
  for(const name of selected.length?selected:['catalog-classification-handover']){
    process.stdout.write(run(process.execPath,[`tests/integration/${name}.mjs`],180000));
  }
}finally{
  if(started)run(`${pg}/pg_ctl`,['-D',`${root}/data`,'-m','fast','-w','stop']);
  console.log(`Disposable PostgreSQL stopped; diagnostics: ${root}`);
}
