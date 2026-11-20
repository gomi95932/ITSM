import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { spawn } from 'node:child_process';

export const VOICE_MAX_BYTES=2_000_000;
export const VOICE_MAX_SECONDS=30;
type VoiceConfig={endpoint:string;model:string;token:string;approvalRef:string};
type AudioInput={audio:string;mimeType:string;consent:true;contentClass:'GENERAL'};
const formats:Record<string,string>={'audio/webm':'matroska','audio/ogg':'ogg','audio/mp4':'mov','audio/wav':'wav'};
const fail=()=>new ServiceUnavailableException({code:'ASR_UNAVAILABLE'});

export function voiceConfiguration(env:NodeJS.ProcessEnv):VoiceConfig|undefined {
  if(env.ENABLE_VOICE_ASR!=='true'||env.VOICE_ASR_DATA_BOUNDARY!=='internal-approved')return;
  const approvalRef=env.VOICE_ASR_APPROVAL_REF?.trim(),model=env.VOICE_ASR_MODEL?.trim(),token=env.VOICE_ASR_TOKEN?.trim();
  if(!approvalRef||!model||!token||/[\r\n]/.test(token)||model.length>200)return;
  try {
    const endpoint=new URL(env.VOICE_ASR_ENDPOINT??'');
    if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash||endpoint.search||!endpoint.pathname.endsWith('/audio/transcriptions'))return;
    return {endpoint:endpoint.href,model,token,approvalRef};
  }catch{return;}
}

export function voiceInput(value:unknown):AudioInput {
  const b=value as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['audio','mimeType','consent','contentClass'].includes(k))||
    b.consent!==true||b.contentClass!=='GENERAL'||typeof b.audio!=='string'||!b.audio||b.audio.length>Math.ceil(VOICE_MAX_BYTES/3)*4||
    b.audio.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.audio)||
    typeof b.mimeType!=='string'||!Object.hasOwn(formats,b.mimeType))throw new BadRequestException({code:'INVALID_AUDIO'});
  const bytes=Buffer.from(b.audio,'base64');
  if(bytes.length>VOICE_MAX_BYTES||bytes.toString('base64')!==b.audio)throw new BadRequestException({code:'INVALID_AUDIO'});
  return b as unknown as AudioInput;
}

// Decode through bounded pipes, never a temporary recording file. Duration comes from actual PCM samples.
export async function normalizedVoice(audio:Buffer,mimeType:string):Promise<Buffer> {
  const format=formats[mimeType];
  if(!format||audio.length>VOICE_MAX_BYTES)throw new BadRequestException({code:'INVALID_AUDIO'});
  const signature=audio.subarray(0,12);
  const matches=mimeType==='audio/webm'?signature.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):
    mimeType==='audio/ogg'?signature.toString('ascii',0,4)==='OggS':
    mimeType==='audio/mp4'?signature.toString('ascii',4,8)==='ftyp':
    signature.toString('ascii',0,4)==='RIFF'&&signature.toString('ascii',8,12)==='WAVE';
  if(!matches)throw new BadRequestException({code:'INVALID_AUDIO'});
  const pcm=await new Promise<Buffer>((resolve,reject)=>{
    const child=spawn('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-xerror','-threads','1',
      '-protocol_whitelist','pipe','-f',format,'-i','pipe:0','-map','0:a:0','-vn','-sn','-dn',
      '-ac','1','-ar','16000','-threads','1','-f','s16le','pipe:1'],{stdio:['pipe','pipe','ignore']});
    const chunks:Buffer[]=[];let count=0,settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill('SIGKILL');reject(error);}else resolve(Buffer.concat(chunks));};
    const timer=setTimeout(()=>finish(new BadRequestException({code:'INVALID_AUDIO'})),5000);
    child.on('error',()=>finish(fail()));
    child.stdin.on('error',()=>{});
    child.stdout.on('data',(chunk:Buffer)=>{count+=chunk.length;
      if(count>VOICE_MAX_SECONDS*32000)finish(new BadRequestException({code:'VOICE_TOO_LONG'}));else chunks.push(chunk);});
    child.on('close',code=>finish(code===0&&count>=3200?undefined:new BadRequestException({code:'INVALID_AUDIO'})));
    child.stdin.end(audio);
  });
  const header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);
  header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);
  header.write('data',36);header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

export async function transcribeVoice(config:VoiceConfig,wav:Buffer,transport:typeof fetch=fetch):Promise<string> {
  const form=new FormData();
  form.set('file',new Blob([new Uint8Array(wav)],{type:'audio/wav'}),'recording.wav');
  form.set('model',config.model);form.set('language','zh');form.set('response_format','json');
  try {
    const response=await transport(config.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:`Bearer ${config.token}`},body:form});
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json')||!response.body){await response.body?.cancel();throw fail();}
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>16384){await reader.cancel();throw fail();}chunks.push(value);}}
    finally{reader.releaseLock();}
    const result:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const text=result&&typeof result==='object'&&!Array.isArray(result)?(result as Record<string,unknown>).text:undefined;
    if(typeof text!=='string'||!text.trim()||text.length>4000)throw fail();
    return text.trim();
  }catch{throw fail();}
}

@Injectable()
export class VoiceAsrService {
  private pending=0;
  config(){return {recordingEnabled:!!voiceConfiguration(process.env),maxSeconds:VOICE_MAX_SECONDS,maxBytes:VOICE_MAX_BYTES,
    reason:voiceConfiguration(process.env)?null:'ASR_UNAVAILABLE'};}
  async transcribe(body:unknown):Promise<{text:string}> {
    const config=voiceConfiguration(process.env);if(!config)throw fail();
    if(this.pending>=2)throw new ServiceUnavailableException({code:'ASR_BUSY'});
    const input=voiceInput(body);this.pending++;
    const audio=Buffer.from(input.audio,'base64');let wav:Buffer|undefined;
    try{wav=await normalizedVoice(audio,input.mimeType);return {text:await transcribeVoice(config,wav)};}
    finally{audio.fill(0);wav?.fill(0);this.pending--;}
  }
}
