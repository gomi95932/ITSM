import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { RequestCatalogService } from './request-catalog.service.js';

@Controller('request-catalog')
export class RequestCatalogController {
  constructor(private readonly auth: AuthService, private readonly catalog: RequestCatalogService) {}

  @Get(':code/versions')
  async versions(@Headers('x-dev-user') user: string | undefined, @Headers('cookie') cookie: string | undefined,
    @Param('code') code: string) {
    return this.catalog.versions(await this.auth.identity({ devUser:user,cookie }),code);
  }

  @Post(':code/versions')
  async publish(@Headers('x-dev-user') user: string | undefined, @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Param('code') code: string, @Body() body: unknown) {
    if (!key) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    return this.catalog.publish(await this.auth.identity({devUser:user,cookie,csrf},true),code,body,key,requestId?.slice(0,128) ?? randomUUID());
  }

  @Post(':code/unpublish') @HttpCode(200)
  async unpublish(@Headers('x-dev-user') user: string | undefined, @Headers('cookie') cookie: string | undefined,
    @Headers('x-csrf-token') csrf: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Param('code') code: string, @Body() body: unknown) {
    if (!key) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    return this.catalog.unpublish(await this.auth.identity({devUser:user,cookie,csrf},true),code,body,key,requestId?.slice(0,128) ?? randomUUID());
  }
}
