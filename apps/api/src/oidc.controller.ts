import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sessionCookie } from './auth.controller.js';
import { OidcService } from './oidc.service.js';
const browserCookie = (value: string, age: number) => `__Secure-itsm_oidc=${value}; Path=/api/v1/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${age}; Secure`;
@Controller('auth/oidc')
export class OidcController {
  constructor(private readonly oidc: OidcService) {}
  @Get('start') async start(@Res() res: Response) {
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    try {
      const result = await this.oidc.start();
      res.setHeader('Set-Cookie',browserCookie(result.browser,300)); res.redirect(303,result.url);
    } catch { res.redirect(303,'/?login=failed'); }
  }
  @Get('callback') async callback(@Query() query: Record<string,unknown>, @Headers('cookie') cookie: string | undefined, @Res() res: Response) {
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer');
    const values = cookie?.split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Secure-itsm_oidc=')) ?? [];
    try {
      const result = await this.oidc.finish(query,values.length === 1 ? values[0].slice('__Secure-itsm_oidc='.length) : undefined);
      res.setHeader('Set-Cookie',[browserCookie('',0),sessionCookie(result.token,28800)]); res.redirect(303,'/');
    } catch { res.setHeader('Set-Cookie',browserCookie('',0)); res.redirect(303,'/?login=failed'); }
  }
}
