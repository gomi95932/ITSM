import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function processDeliveryCommands(mode='NORMAL') {
  if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
  if(!['NORMAL','CONCURRENT','FAIL','CALLBACK','WITHDRAW'].includes(mode))throw new Error('INVALID_DELIVERY_CI_MODE');
  const runner=await readFile(new URL('../integration/request-delivery-runner.mjs',import.meta.url),'utf8');
  await new Promise((resolve,reject)=>{
    const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
      '-f','infra/compose/compose.yaml','exec','-T','-e','ITSM_DELIVERY_CI=true','-e',`ITSM_DELIVERY_CI_MODE=${mode}`,
      'worker','node','--input-type=module'],{stdio:['pipe','inherit','inherit']});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('REQUEST_DELIVERY_CI_FAILED')));
    child.stdin.end(runner);
  });
}
