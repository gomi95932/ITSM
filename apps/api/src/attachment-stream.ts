import { BadRequestException } from '@nestjs/common';
import type { Readable } from 'node:stream';

export function readAttachmentUpload(req:Readable,size:number,timeoutMs=60_000):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    let count=0,settled=false;const parts:Buffer[]=[];
    const clean=()=>{clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',fail);req.off('close',fail);};
    const fail=()=>{if(settled)return;settled=true;clean();reject(new BadRequestException({code:'INVALID_ATTACHMENT'}));};
    const data=(chunk:Buffer)=>{count+=chunk.length;if(count>size){fail();req.destroy();}else parts.push(chunk);};
    const end=()=>{
      if(count!==size)return fail();
      if(settled)return;settled=true;clean();resolve(Buffer.concat(parts,count));
    };
    const timer=setTimeout(()=>{fail();req.destroy();},timeoutMs);
    req.on('data',data);req.once('end',end);req.once('error',fail);req.once('close',fail);
    if(req.destroyed||req.readableEnded)fail();
  });
}
