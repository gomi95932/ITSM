import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const runner=await readFile(new URL('./directory-sync-runner.mjs',import.meta.url),'utf8');
await new Promise((resolve,reject)=>{
  const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,
    '-f','infra/compose/compose.yaml','run','--no-deps','--rm','-T','-e','ITSM_DIRECTORY_CI=true',
    '--entrypoint','node','worker','--input-type=module'],{stdio:['pipe','inherit','inherit']});
  child.once('error',reject);
  child.once('close',code=>code===0?resolve():reject(new Error('DIRECTORY_SYNC_CI_FAILED')));
  child.stdin.end(runner);
});
