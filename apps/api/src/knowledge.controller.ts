import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service.js';
import { KnowledgeService } from './knowledge.service.js';

type HeadersMap = Record<string,string|undefined>;

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly auth: AuthService, private readonly knowledge: KnowledgeService) {}

  private identity(h: HeadersMap, write=false) {
    return this.auth.identity({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']},write);
  }
  private key(h: HeadersMap) {
    if (!h['idempotency-key']) throw new BadRequestException({code:'IDEMPOTENCY_KEY_REQUIRED'});
    return h['idempotency-key'];
  }
  private requestId(h: HeadersMap) { return h['x-request-id']?.slice(0,128) ?? randomUUID(); }

  @Get()
  async list(@Headers() h: HeadersMap,@Query('scope') scope?: string,@Query('search') search?: string) {
    return this.knowledge.list(await this.identity(h),scope,search);
  }

  @Get('roles')
  async roles(@Headers() h: HeadersMap) { return this.knowledge.roles(await this.identity(h)); }

  @Get(':id')
  async get(@Headers() h: HeadersMap,@Param('id') id: string,@Query('scope') scope?: string) {
    if (scope && scope!=='managed') throw new BadRequestException({code:'INVALID_KNOWLEDGE_SCOPE'});
    return this.knowledge.get(await this.identity(h),id,scope==='managed');
  }

  @Post()
  async create(@Headers() h: HeadersMap,@Body() body: unknown) {
    return this.knowledge.create(await this.identity(h,true),body,this.key(h),this.requestId(h));
  }

  @Post(':id/revise') @HttpCode(200)
  async revise(@Headers() h: HeadersMap,@Param('id') id: string,@Body() body: unknown) {
    return this.knowledge.revise(await this.identity(h,true),id,body,this.key(h),this.requestId(h));
  }

  @Post(':id/feedback') @HttpCode(200)
  async feedback(@Headers() h: HeadersMap,@Param('id') id: string,@Body() body: unknown) {
    return this.knowledge.feedback(await this.identity(h,true),id,body,this.key(h),this.requestId(h));
  }

  @Post(':id/:action') @HttpCode(200)
  async transition(@Headers() h: HeadersMap,@Param('id') id: string,@Param('action') action: string,@Body() body: unknown) {
    if (!['submit','approve','reject','publish','archive'].includes(action)) throw new BadRequestException({code:'INVALID_KNOWLEDGE_ACTION'});
    return this.knowledge.transition(await this.identity(h,true),id,action.toUpperCase() as 'SUBMIT'|'APPROVE'|'REJECT'|'PUBLISH'|'ARCHIVE',
      body,this.key(h),this.requestId(h));
  }
}
