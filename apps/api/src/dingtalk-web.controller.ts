import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sessionCookie } from './auth.controller.js';
import { DingtalkWebService } from './dingtalk-web.service.js';
const browserCookie=(value:string,age:number)=>`__Secure-itsm_dingtalk_web=${value}; Path=/api/v1/auth/dingtalk-web; HttpOnly; SameSite=Lax; Max-Age=${age}; Secure`;
@Controller('auth/dingtalk-web')
export class DingtalkWebController {
  constructor(private readonly login:DingtalkWebService) {}
  @Get('start') async start(@Res() res:Response) {
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    try {
      const result=await this.login.start();
      res.setHeader('Set-Cookie',browserCookie(result.browser,300));res.redirect(303,result.url);
    } catch {res.redirect(303,'/?login=failed');}
  }
  @Get('callback') async callback(@Query() query:Record<string,unknown>,@Headers('cookie') cookie:string|undefined,@Res() res:Response) {
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    const values=cookie?.split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Secure-itsm_dingtalk_web='))??[];
    try {
      const result=await this.login.finish(query,values.length===1?values[0].slice('__Secure-itsm_dingtalk_web='.length):undefined);
      res.setHeader('Set-Cookie',[browserCookie('',0),sessionCookie(result.token,28800)]);res.redirect(303,'/');
    } catch {res.setHeader('Set-Cookie',browserCookie('',0));res.redirect(303,'/?login=failed');}
  }
}
