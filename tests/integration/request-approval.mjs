import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ITSM_CI_ENV) throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const runner = await readFile(new URL('./request-approval-runner.mjs',import.meta.url),'utf8');
const compose=['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml'];
async function run(args,input) {
  await new Promise((resolve,reject)=>{
    const child=spawn('docker',[...compose,...args],{stdio:[input?'pipe':'ignore','inherit','inherit']});
    child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(new Error('REQUEST_APPROVAL_CI_FAILED')));
    if(input)child.stdin.end(input);
  });
}
// Maintenance also locks approvals when live OA dispatch is disabled. The fixture owns its queue.
await run(['stop','worker']);
try {
  await run(['run','--no-deps','--rm','-T','-e','ITSM_APPROVAL_CI=true','--entrypoint','node','worker','--input-type=module'],runner);
} finally {
  await run(['up','-d','--no-deps','--wait','worker']);
}
