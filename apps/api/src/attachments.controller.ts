import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { AttachmentsService } from './attachments.service.js';

@Controller('tickets/:ticketId/attachments')
export class AttachmentsController {
  constructor(private readonly auth:AuthService,private readonly attachments:AttachmentsService){}
  private identity(h:Record<string,string|undefined>,write=false){return this.auth.identity({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']},write);}
  private requestId(h:Record<string,string|undefined>){return h['x-request-id']?.slice(0,128)||randomUUID();}
  @Get() async list(@Headers() h:Record<string,string|undefined>,@Param('ticketId') ticketId:string){return this.attachments.list(await this.identity(h),ticketId);}
  @Post('presign') async presign(@Headers() h:Record<string,string|undefined>,@Param('ticketId') ticketId:string,@Body() body:unknown){
    return this.attachments.presign(await this.identity(h,true),ticketId,body,h['idempotency-key']??'',this.requestId(h));
  }
  @Put(':id/content') @HttpCode(200) async upload(@Headers() h:Record<string,string|undefined>,@Param('ticketId') ticketId:string,@Param('id') id:string,@Req() req:Request){
    return this.attachments.upload(await this.identity(h,true),ticketId,id,req,this.requestId(h));
  }
  @Post(':id/download') @HttpCode(200) async grant(@Headers() h:Record<string,string|undefined>,@Param('ticketId') ticketId:string,@Param('id') id:string){
    return this.attachments.downloadGrant(await this.identity(h,true),ticketId,id,this.requestId(h));
  }
  @Get(':id/content') async download(@Headers() h:Record<string,string|undefined>,@Param('ticketId') ticketId:string,@Param('id') id:string,@Res() res:Response){
    const result=await this.attachments.download(await this.identity(h),ticketId,id,h,this.requestId(h));
    try {
    res.setHeader('Content-Type',result.mime);res.setHeader('Content-Length',result.bytes.length);
    res.setHeader('Content-Disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    res.setHeader('Cache-Control','private, no-store');res.once('close',result.release);res.end(result.bytes,result.release);
    } catch(error) {result.release();throw error;}
  }
}
