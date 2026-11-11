import { Body, Controller, Get, Headers, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';

type CookieResponse = { setHeader(name: string, value: string): void };
const cookie = (value: string, age: number) => `itsm_session=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Get('config') config() { return this.auth.config(); }
  @Get('me') me(@Headers('x-dev-user') devUser?: string, @Headers('cookie') cookie?: string) {
    return this.auth.identity({ devUser, cookie });
  }
  @Post('dingtalk') @HttpCode(200)
  async login(@Headers('x-itsm-login') marker: string | undefined, @Body() body: unknown, @Res({ passthrough: true }) res: CookieResponse) {
    // A non-simple custom header prevents cross-site form login. CORS is not enabled.
    if (marker !== '1' || !body || typeof body !== 'object' || Object.keys(body).join(',') !== 'code') throw new UnauthorizedException();
    const result = await this.auth.login((body as { code: unknown }).code);
    res.setHeader('Set-Cookie', cookie(result.token, 28800));
    return { csrfToken: result.csrfToken };
  }
  @Post('logout') @HttpCode(200)
  async logout(@Headers('cookie') session?: string, @Headers('x-csrf-token') csrf?: string, @Headers('x-dev-user') devUser?: string,
    @Res({ passthrough: true }) res?: CookieResponse) {
    await this.auth.identity({ cookie: session, csrf, devUser }, true);
    await this.auth.logout(session); res?.setHeader('Set-Cookie', cookie('', 0)); return { ok: true };
  }
}
