import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { Database } from './database.service.js';
import type { Identity } from './auth.service.js';
import { TicketsService } from './tickets.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { attachmentConfiguration, attachmentInput, attachmentMagic, attachmentSignature, validAttachmentSignature, type AttachmentConfig } from './attachment-policy.js';
import { scanAttachment } from './attachment-scanner.js';
import { readAttachmentUpload } from './attachment-stream.js';

type AttachmentRow={id:string;ticket_id:string;object_key:string;name:string;sha256:string;mime:string;size:number;visibility:'PUBLIC'|'INTERNAL';
  uploader_id:string;scan_status:string;upload_key:string;request_hash:string;expires_at:Date;created_at:Date};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const unavailable=()=>new ServiceUnavailableException({code:'ATTACHMENTS_UNAVAILABLE'});

@Injectable()
export class AttachmentsService {
  private activeUploads=0;
  private activeDownloads=0;
  constructor(private readonly db:Database,private readonly tickets:TicketsService,private readonly intake:IntakePolicyService){}
  private config():AttachmentConfig {const config=attachmentConfiguration(process.env);if(!config)throw unavailable();return config;}
  private async root(config:AttachmentConfig) {
    try{
      const stat=await lstat(config.root);
      if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||await realpath(config.root)!==config.root)throw unavailable();
    }catch{throw unavailable();}
  }
  private async audit(client:PoolClient,id:string,actor:string,action:string,requestId:string) {
    await client.query('INSERT INTO attachment_audits(attachment_id,actor_id,action,request_id) VALUES ($1,$2,$3,$4)',[id,actor,action,requestId.slice(0,128)]);
  }
  private async visible(client:PoolClient,actor:Identity,ticketId:string,id:string) {
    if(!uuid.test(id))throw new NotFoundException();
    const access=await this.tickets.attachmentAccess(client,actor,ticketId);
    const row=(await client.query<AttachmentRow>('SELECT * FROM attachments WHERE id=$1 AND ticket_id=$2 FOR UPDATE',[id,ticketId])).rows[0];
    if(!row||row.visibility==='INTERNAL'&&!access.internal)throw new NotFoundException();
    if(row.object_key!==`${row.id}.blob`)throw unavailable();
    return {row,access};
  }
  async list(actor:Identity,ticketId:string) {
    return this.db.transaction(async client=>{
      const access=await this.tickets.attachmentAccess(client,actor,ticketId),config=attachmentConfiguration(process.env);
      const items=(await client.query(`SELECT id,name,mime,size,sha256,visibility,scan_status AS "scanStatus",created_at AS "createdAt"
        FROM attachments WHERE ticket_id=$1 AND (visibility='PUBLIC' OR $2) ORDER BY created_at,id LIMIT 100`,[ticketId,access.internal])).rows;
      return {items,enabled:process.env.ENABLE_ATTACHMENTS==='true',configured:!!config,canUpload:!!config&&access.writable,canInternal:access.internal,maxBytes:config?.maxBytes??0};
    });
  }
  async presign(actor:Identity,ticketId:string,body:unknown,key:string,requestId:string) {
    const config=this.config(),input=attachmentInput(body,config.maxBytes);
    if(!input)throw new BadRequestException({code:'INVALID_ATTACHMENT'});
    if(!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw new BadRequestException({code:'ATTACHMENT_KEY_REQUIRED'});
    await this.intake.requireGeneral(actor.id,{contentClass:input.contentClass,name:input.name},'attachment');
    await this.root(config);
    return this.db.transaction(async client=>{
      const access=await this.tickets.attachmentAccess(client,actor,ticketId);
      if(!access.writable)throw new ConflictException({code:'ATTACHMENT_TICKET_CLOSED'});
      if(input.visibility==='INTERNAL'&&!access.internal)throw new ForbiddenException({code:'ATTACHMENT_INTERNAL_DENIED'});
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`attachment:${actor.id}`]);
      await client.query('SELECT id FROM tickets WHERE id=$1 FOR UPDATE',[ticketId]);
      const hash=digest(JSON.stringify([ticketId,input]));
      let row=(await client.query<AttachmentRow>('SELECT * FROM attachments WHERE uploader_id=$1 AND upload_key=$2',[actor.id,key])).rows[0];
      if(row){
        if(row.request_hash!==hash)throw new ConflictException({code:'ATTACHMENT_KEY_CONFLICT'});
        if(row.expires_at.getTime()<=Date.now()||row.scan_status!=='PENDING')throw new ConflictException({code:'ATTACHMENT_UPLOAD_FINISHED'});
      }else{
        const quota=(await client.query<{count:number;total:string;daily:string}>(`SELECT count(*)::integer AS count,coalesce(sum(size),0)::text AS total,
          (SELECT coalesce(sum(size),0)::text FROM attachments WHERE uploader_id=$2 AND created_at>now()-interval '24 hours') AS daily
          FROM attachments WHERE ticket_id=$1`,[ticketId,actor.id])).rows[0];
        if(quota.count>=100||Number(quota.total)+input.size>500*1024*1024||Number(quota.daily)+input.size>100*1024*1024)
          throw new ConflictException({code:'ATTACHMENT_QUOTA_EXCEEDED'});
        const id=randomUUID();
        row=(await client.query<AttachmentRow>(`INSERT INTO attachments(id,ticket_id,object_key,name,sha256,mime,size,visibility,uploader_id,upload_key,request_hash,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()+interval '5 minutes') RETURNING *`,
        [id,ticketId,`${id}.blob`,input.name,input.sha256,input.mime,input.size,input.visibility,actor.id,key,hash])).rows[0];
        await this.audit(client,id,actor.id,'RESERVED',requestId);
      }
      const expires=row.expires_at.getTime();
      return {id:row.id,url:`/api/v1/tickets/${ticketId}/attachments/${row.id}/content`,method:'PUT',expiresAt:row.expires_at,
        headers:{'Content-Type':'application/octet-stream','X-ITSM-Attachment-Expires':String(expires),
          'X-ITSM-Attachment-Token':attachmentSignature(config.signingKey,row.id,actor.id,'upload',expires)}};
    });
  }
  async upload(actor:Identity,ticketId:string,id:string,req:Request,requestId:string) {
    const config=this.config();
    if(this.activeUploads>=2)throw new ServiceUnavailableException({code:'ATTACHMENT_BUSY'});
    this.activeUploads++;
    let claimed=false;
    try{
      const row=await this.db.transaction(async client=>{
        const {row,access}=await this.visible(client,actor,ticketId,id),expires=Number(req.headers['x-itsm-attachment-expires']);
        if(row.uploader_id!==actor.id||expires!==row.expires_at.getTime()||!validAttachmentSignature(config.signingKey,req.headers['x-itsm-attachment-token'],id,actor.id,'upload',expires))
          throw new ForbiddenException({code:'ATTACHMENT_LINK_EXPIRED'});
        if(!access.writable||row.scan_status!=='PENDING')throw new ConflictException({code:'ATTACHMENT_UPLOAD_FINISHED'});
        if(req.headers['content-type']!=='application/octet-stream'||req.headers['content-encoding']||Number(req.headers['content-length'])!==row.size)
          throw new BadRequestException({code:'INVALID_ATTACHMENT'});
        await client.query("UPDATE attachments SET scan_status='UPLOADING' WHERE id=$1",[id]);return row;
      });
      claimed=true;
      const bytes=await readAttachmentUpload(req,row.size);
      if(digest(bytes)!==row.sha256||!attachmentMagic(bytes,row.mime))throw new BadRequestException({code:'ATTACHMENT_CONTENT_MISMATCH'});
      if(row.mime.startsWith('text/'))await this.intake.requireGeneral(actor.id,{contentClass:'GENERAL',description:bytes.toString('utf8')},'attachment');
      await this.root(config);
      const file=await open(join(config.root,row.object_key),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await file.writeFile(bytes);await file.sync();await file.chmod(0o400);}finally{await file.close();}
      await this.db.transaction(async client=>{
        await client.query("UPDATE attachments SET scan_status='SCANNING' WHERE id=$1 AND scan_status='UPLOADING'",[id]);
        await this.audit(client,id,actor.id,'UPLOADED',requestId);
      });
      const result=await scanAttachment(config.host,config.port,bytes),state=result.clean?'CLEAN':'QUARANTINED';
      await this.db.transaction(async client=>{
        const {access}=await this.visible(client,actor,ticketId,id);
        if(!access.writable)throw new ConflictException({code:'ATTACHMENT_TICKET_CLOSED'});
        await client.query('UPDATE attachments SET scan_status=$2,scanned_at=now(),scanner_version=$3 WHERE id=$1 AND scan_status=\'SCANNING\'',[id,state,result.version]);
        await this.audit(client,id,actor.id,state,requestId);
      });return {id,scanStatus:state};
    }catch(error){
      if(claimed)await this.db.transaction(async client=>{
        await client.query("UPDATE attachments SET scan_status='FAILED',failure_code='UPLOAD_OR_SCAN_FAILED' WHERE id=$1 AND scan_status IN ('UPLOADING','SCANNING')",[id]);
        await this.audit(client,id,actor.id,'FAILED',requestId);
      });
      if(error instanceof BadRequestException||error instanceof ForbiddenException||error instanceof ConflictException||error instanceof NotFoundException)throw error;
      throw unavailable();
    }finally{this.activeUploads--;}
  }
  async downloadGrant(actor:Identity,ticketId:string,id:string,requestId:string) {
    const config=this.config();
    return this.db.transaction(async client=>{
      const {row}=await this.visible(client,actor,ticketId,id);
      if(row.scan_status!=='CLEAN')throw new ConflictException({code:'ATTACHMENT_NOT_CLEAN'});
      const expires=Date.now()+60_000;await this.audit(client,id,actor.id,'DOWNLOAD_GRANTED',requestId);
      return {url:`/api/v1/tickets/${ticketId}/attachments/${id}/content`,expiresAt:new Date(expires),
        headers:{'X-ITSM-Attachment-Expires':String(expires),'X-ITSM-Attachment-Token':attachmentSignature(config.signingKey,id,actor.id,'download',expires)}};
    });
  }
  async download(actor:Identity,ticketId:string,id:string,headers:Record<string,string|undefined>,requestId:string) {
    const config=this.config();
    if(!validAttachmentSignature(config.signingKey,headers['x-itsm-attachment-token'],id,actor.id,'download',Number(headers['x-itsm-attachment-expires'])))
      throw new ForbiddenException({code:'ATTACHMENT_LINK_EXPIRED'});
    if(this.activeDownloads>=4)throw new ServiceUnavailableException({code:'ATTACHMENT_BUSY'});
    this.activeDownloads++;let released=false;
    const release=()=>{if(!released){released=true;this.activeDownloads--;}};
    try{return await this.db.transaction(async client=>{
      const {row}=await this.visible(client,actor,ticketId,id);
      if(row.scan_status!=='CLEAN')throw new ConflictException({code:'ATTACHMENT_NOT_CLEAN'});
      await this.root(config);
      const file=await open(join(config.root,row.object_key),constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
      try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size!==row.size)throw unavailable();bytes=await file.readFile();}finally{await file.close();}
      if(digest(bytes)!==row.sha256)throw unavailable();
      await this.audit(client,id,actor.id,'DOWNLOADED',requestId);return {bytes,name:row.name,mime:row.mime,release};
    });}catch(error){release();if(error instanceof ConflictException||error instanceof NotFoundException||error instanceof ForbiddenException)throw error;throw unavailable();}
  }
}
