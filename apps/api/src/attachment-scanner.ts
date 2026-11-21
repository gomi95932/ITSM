import { createConnection } from 'node:net';

async function clamdCommand(host:string,port:number,command:string,bytes:Buffer|undefined,timeoutMs:number):Promise<string> {
  const socket=createConnection({host,port});
  return new Promise<string>((resolve,reject)=>{
    let reply=Buffer.alloc(0),settled=false,sent=false,complete=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(reply.toString('utf8').replace(/\0$/,''));};
    const timer=setTimeout(()=>finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE')),timeoutMs);
    socket.on('error',()=>finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE')));
    socket.on('data',(chunk:Buffer)=>{
      reply=Buffer.concat([reply,chunk]);
      if(reply.length>4096||complete)return finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE'));
      if(reply.includes(0)){
        if(reply.indexOf(0)!==reply.length-1)return finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE'));
        complete=true;if(sent)finish();
      }
    });
    socket.on('close',()=>{if(!settled)finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE'));});
    socket.on('end',()=>{if(!complete)finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE'));});
    const write=(chunk:Buffer|string)=>new Promise<void>((done,fail)=>{
      if(settled||socket.destroyed)return fail(new Error('ATTACHMENT_SCANNER_UNAVAILABLE'));
      socket.write(chunk,error=>error?fail(error):done());
    });
    socket.once('connect',()=>{
      void (async()=>{
        await write(`z${command}\0`);
        if(bytes){
          for(let offset=0;offset<bytes.length;offset+=65536){
            const chunk=bytes.subarray(offset,offset+65536),header=Buffer.alloc(4);header.writeUInt32BE(chunk.length);
            await write(Buffer.concat([header,chunk]));
          }
          await write(Buffer.alloc(4));
        }
        sent=true;if(complete)finish();
      })().catch(()=>finish(new Error('ATTACHMENT_SCANNER_UNAVAILABLE')));
    });
  });
}
export async function scanAttachment(host:string,port:number,bytes:Buffer,timeoutMs=60_000):Promise<{clean:boolean;version:string}> {
  const version=await clamdCommand(host,port,'VERSION',undefined,timeoutMs);
  const match=/^ClamAV [^/\r\n]+\/\d+\/(.+)$/.exec(version),date=match?Date.parse(match[1]):NaN;
  if(!Number.isFinite(date)||date>Date.now()+300_000||Date.now()-date>72*3600_000)throw new Error('ATTACHMENT_SCANNER_STALE');
  const reply=await clamdCommand(host,port,'INSTREAM',bytes,timeoutMs);
  if(reply==='stream: OK')return {clean:true,version};
  if(/^stream: [^\r\n]+ FOUND$/.test(reply))return {clean:false,version};
  throw new Error('ATTACHMENT_SCANNER_UNAVAILABLE');
}
