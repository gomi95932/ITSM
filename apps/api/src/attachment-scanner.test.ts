import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer,type Socket } from 'node:net';
import { scanAttachment } from './attachment-scanner.js';

// Protocol fixtures test failure handling only; they are not antivirus acceptance evidence.
async function fixture(run:(port:number)=>Promise<void>,response='stream: OK',version=`ClamAV 1.4.0/123/${new Date().toUTCString()}`,behavior='normal'){
  const sockets=new Set<Socket>();let received=Buffer.alloc(0);
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let pending=Buffer.alloc(0),command='',remaining=-1;
    socket.on('data',chunk=>{
      if(behavior==='disconnect'){socket.destroy();return;}
      if(behavior==='stall')return;
      pending=Buffer.concat([pending,chunk]);
      if(!command){const end=pending.indexOf(0);if(end<0)return;command=pending.toString('utf8',0,end);pending=pending.subarray(end+1);
        if(command==='zVERSION'){socket.end(`${version}\0`);return;}assert.equal(command,'zINSTREAM');}
      while(true){
        if(remaining===-1){if(pending.length<4)return;remaining=pending.readUInt32BE(0);pending=pending.subarray(4);if(!remaining){socket.end(`${response}\0`);return;}}
        if(pending.length<remaining)return;
        received=Buffer.concat([received,pending.subarray(0,remaining)]);pending=pending.subarray(remaining);remaining=-1;
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await run((server.address() as {port:number}).port);}finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  return received;
}
test('ClamAV protocol streams bounded chunks and distinguishes clean from detected content',async()=>{
  const bytes=Buffer.alloc(200_000,65);
  const received=await fixture(async port=>{assert.equal((await scanAttachment('127.0.0.1',port,bytes,1000)).clean,true);});assert.deepEqual(received,bytes);
  await fixture(async port=>{assert.equal((await scanAttachment('127.0.0.1',port,bytes,1000)).clean,false);},'stream: Fixture.Signature FOUND');
});
test('unavailable, stale, malformed and oversized scanner replies fail closed',async()=>{
  for(const reply of ['stream: size limit exceeded ERROR','unexpected','x'.repeat(5000)])
    await fixture(port=>assert.rejects(scanAttachment('127.0.0.1',port,Buffer.from('abc'),1000)),reply);
  for(const version of ['ClamAV unknown',`ClamAV 1.4/123/${new Date(Date.now()-73*3600_000).toUTCString()}`,
    `ClamAV 1.4/123/${new Date(Date.now()+600_000).toUTCString()}`])
    await fixture(port=>assert.rejects(scanAttachment('127.0.0.1',port,Buffer.from('abc'),1000)),'stream: OK',version);
  for(const behavior of ['disconnect','stall'])await fixture(port=>assert.rejects(scanAttachment('127.0.0.1',port,Buffer.alloc(200_000),30)),undefined,undefined,behavior);
});
