import { createHmac, timingSafeEqual } from 'node:crypto';

export const ATTACHMENT_HARD_LIMIT=20*1024*1024;
export const ATTACHMENT_MIMES=['image/png','image/jpeg','application/pdf','text/plain','text/csv'] as const;
export type AttachmentInput={name:string;mime:string;size:number;sha256:string;visibility:'PUBLIC'|'INTERNAL';contentClass:'GENERAL'};
export type AttachmentConfig={root:string;signingKey:string;host:string;port:number;maxBytes:number;approvalRef:string};
export function attachmentConfiguration(env:NodeJS.ProcessEnv):AttachmentConfig|undefined {
  const port=Number(env.ATTACHMENT_CLAMD_PORT??3310),maxBytes=Number(env.ATTACHMENT_MAX_BYTES??ATTACHMENT_HARD_LIMIT);
  if(env.ENABLE_ATTACHMENTS!=='true'||!env.ATTACHMENT_STORAGE_APPROVAL_REF?.trim()||
    !/^[a-f0-9]{64,128}$/.test(env.ATTACHMENT_SIGNING_KEY??'')||
    !/^[a-zA-Z0-9.-]{1,253}$/.test(env.ATTACHMENT_CLAMD_HOST??'')||
    !Number.isInteger(port)||port<1||port>65535||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>ATTACHMENT_HARD_LIMIT)return;
  return {root:'/var/lib/itsm/attachments',signingKey:env.ATTACHMENT_SIGNING_KEY!,host:env.ATTACHMENT_CLAMD_HOST!,port,maxBytes,approvalRef:env.ATTACHMENT_STORAGE_APPROVAL_REF.trim()};
}
export function attachmentInput(value:unknown,maxBytes=ATTACHMENT_HARD_LIMIT):AttachmentInput|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const b=value as Record<string,unknown>;
  if(Object.keys(b).some(k=>!['name','mime','size','sha256','visibility','contentClass'].includes(k))||
    typeof b.name!=='string'||!b.name.trim()||b.name!==b.name.trim()||b.name.length>180||/[\x00-\x1f\x7f/\\<>:"|?*\u202a-\u202e\u2066-\u2069]/.test(b.name)||
    typeof b.mime!=='string'||!ATTACHMENT_MIMES.includes(b.mime as typeof ATTACHMENT_MIMES[number])||
    !Number.isInteger(b.size)||Number(b.size)<1||Number(b.size)>maxBytes||
    typeof b.sha256!=='string'||!/^[a-f0-9]{64}$/.test(b.sha256)||
    !['PUBLIC','INTERNAL'].includes(String(b.visibility))||b.contentClass!=='GENERAL')return;
  const extensions:Record<string,RegExp>={'image/png':/\.png$/i,'image/jpeg':/\.jpe?g$/i,'application/pdf':/\.pdf$/i,'text/plain':/\.(txt|log)$/i,'text/csv':/\.csv$/i};
  if(!extensions[b.mime].test(b.name))return;
  return {name:b.name,mime:b.mime,size:Number(b.size),sha256:b.sha256,
    visibility:b.visibility as AttachmentInput['visibility'],contentClass:'GENERAL'};
}
export function attachmentMagic(bytes:Buffer,mime:string):boolean {
  if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg')return bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mime==='application/pdf')return bytes.toString('ascii',0,5)==='%PDF-';
  if(mime==='text/plain'||mime==='text/csv'){
    try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      return !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)&&!/<\s*(?:!doctype\s+html|html|script|svg)\b/i.test(text);
    }catch{return false;}
  }
  return false;
}
export function attachmentSignature(key:string,id:string,actor:string,operation:'upload'|'download',expires:number):string {
  return createHmac('sha256',Buffer.from(key,'hex')).update(JSON.stringify([id,actor,operation,expires])).digest('hex');
}
export function validAttachmentSignature(key:string,token:unknown,id:string,actor:string,operation:'upload'|'download',expires:number,now=Date.now()):boolean {
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||!Number.isSafeInteger(expires)||expires<=now||expires>now+300_000)return false;
  return timingSafeEqual(Buffer.from(token,'hex'),Buffer.from(attachmentSignature(key,id,actor,operation,expires),'hex'));
}
