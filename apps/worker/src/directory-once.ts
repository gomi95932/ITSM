import { Pool } from 'pg';
import { directorySettings,synchronizeDirectory,restrictDirectory } from './directory-sync.js';
import { dingtalkDirectory } from './directory-provider.js';

async function main(){
const db=new Pool({host:process.env.DB_HOST??'db',port:Number(process.env.DB_PORT??5432),database:process.env.DB_NAME??'itsm',
  user:process.env.DB_USER??'itsm',password:process.env.DB_PASSWORD,connectionTimeoutMillis:5000,statement_timeout:30000});
try {
  const args=process.argv.slice(2),apply=args.length===1&&args[0]==='--apply';
  if(!(args.length===0||apply))throw new Error('DIRECTORY_ARGUMENTS_INVALID');
  const settings=directorySettings(process.env);
  if(!settings?.pilotUserIds||settings.retireMissing||!process.env.DINGTALK_APP_KEY||!process.env.DINGTALK_APP_SECRET)
    throw new Error('DIRECTORY_PILOT_CONFIG_REQUIRED');
  let token:string|undefined;
  const provider=dingtalkDirectory({roots:settings.roots,token:async signal=>{
    if(token)return token;
    const url=new URL('https://oapi.dingtalk.com/gettoken');
    url.searchParams.set('appkey',process.env.DINGTALK_APP_KEY!);url.searchParams.set('appsecret',process.env.DINGTALK_APP_SECRET!);
    const response=await fetch(url,{signal,redirect:'error'});
    if(!response.ok)throw new Error('DIRECTORY_TOKEN_UNAVAILABLE');
    const data=await response.json() as {errcode?:number;access_token?:string};
    if(data.errcode!==0||!data.access_token)throw new Error('DIRECTORY_TOKEN_UNAVAILABLE');
    return token=data.access_token;
  }});
  if(apply){
    const result=await synchronizeDirectory(db,settings,provider);
    console.log(JSON.stringify(result));if(result.state!=='SUCCEEDED')process.exitCode=1;
  }else{
    const snapshot=restrictDirectory(await provider.snapshot(AbortSignal.timeout(120000)),settings.pilotUserIds);
    console.log(JSON.stringify({state:'PREVIEW',people:snapshot.people.map(p=>({userId:p.userId,name:p.name})),departmentCount:snapshot.departmentCount}));
  }
} catch(error) {
  console.error(error instanceof Error&&/^DIRECTORY_[A-Z_]+$/.test(error.message)?error.message:'DIRECTORY_PREFLIGHT_FAILED');process.exitCode=1;
} finally {await db.end();}
}
void main();
