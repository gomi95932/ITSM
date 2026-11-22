import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const source=await readFile(new URL('./dingtalk-web-login-runner.mjs',import.meta.url));
const child=spawn('docker',['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml',
  'exec','-T','-e','ITSM_DINGTALK_WEB_CI=true','api','node','--input-type=module'],{stdio:['pipe','inherit','inherit']});
child.stdin.end(source);await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('DINGTALK_WEB_INTEGRATION_FAILED')));});
