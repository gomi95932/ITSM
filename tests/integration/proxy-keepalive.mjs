import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if(process.env.GITHUB_ACTIONS!=='true'||!process.env.ITSM_CI_ENV)throw new Error('DISPOSABLE_GITHUB_CI_ONLY');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
const prefix=`itsm-proxy-ci-${process.pid}`,network=`${prefix}-net`,api=`${prefix}-api`,web=`${prefix}-web`,blocker=`${prefix}-old-ip`;
const compose=['compose','--project-name','itsm-dev','--env-file',process.env.ITSM_CI_ENV,'-f','infra/compose/compose.yaml'];
const image=service=>docker('inspect','--format','{{.Config.Image}}',docker(...compose,'ps','-q',service));
const apiImage=image('api'),webImage=image('web');
const backend=`const http=require('node:http');const ports=new Set();http.createServer((q,s)=>{ports.add(q.socket.remotePort);s.setHeader('Content-Type','application/json');s.end(JSON.stringify({generation:process.env.GENERATION,connections:ports.size,url:q.url}));}).listen(3000,'0.0.0.0');`;
const address=name=>JSON.parse(docker('inspect',name))[0].NetworkSettings.Networks[network].IPAddress;
const startApi=generation=>docker('run','-d','--name',api,'--network',network,'--network-alias','api','-e',`GENERATION=${generation}`,'--entrypoint','node',apiImage,'-e',backend);
let base;
async function request(path='/api/probe'){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);
  return response.json();
}
async function ready(generation){
  let last;
  for(let i=0;i<150;i++){
    try{const result=await request();if(result.generation===generation)return result;}catch(error){last=error;}
    await delay(100);
  }
  throw last??new Error('PROXY_DNS_DID_NOT_RECOVER');
}
try{
  docker('network','create',network);
  startApi('first');
  docker('run','-d','--name',web,'--network',network,'-p','127.0.0.1::80','--mount',`type=bind,src=${resolve('apps/web/nginx.conf')},dst=/etc/nginx/conf.d/default.conf,readonly`,webImage);
  const port=JSON.parse(docker('inspect',web))[0].NetworkSettings.Ports['80/tcp'][0].HostPort;
  base=`http://127.0.0.1:${port}`;
  await ready('first');
  const paths=['/api/probe','/api/v1/tickets/12345678-abcd/attachments/abcdef12-3456/content'];
  await Promise.all(Array.from({length:10},async(_,lane)=>{
    for(let i=0;i<400;i++){
      const path=paths[(i+lane)%2],result=await request(path);
      assert.equal(result.generation,'first');assert.equal(result.url,path);
      assert(result.connections<100,'upstream connections must be reused on both routes');
    }
  }));
  const reused=await request();
  const oldIp=address(api);
  docker('rm','-f',api);
  docker('run','-d','--name',blocker,'--network',network,'--ip',oldIp,'--entrypoint','node',apiImage,'-e','setInterval(()=>{},1000)');
  startApi('replacement');
  assert.notEqual(address(api),oldIp,'replacement must have a different address');
  const recovered=await ready('replacement');
  for(const path of paths)assert.equal((await request(path)).generation,'replacement');
  console.log(JSON.stringify({requests:4000,upstreamConnections:reused.connections,differentIpRecovery:true,
    replacementConnections:recovered.connections,attachmentRoute:true}));
}finally{
  for(const name of [web,api,blocker]){try{docker('rm','-f',name);}catch{}}
  try{docker('network','rm',network);}catch{}
}
