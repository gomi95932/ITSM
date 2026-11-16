import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TicketsService } from './tickets.service.js';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  async create(@Headers('x-dev-user') user: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Body() body: unknown,
    @Headers('cookie') cookie?: string, @Headers('x-csrf-token') csrf?: string): Promise<object> {
    return this.tickets.create(await this.tickets.identity({ devUser:user,cookie,csrf },true), body, key ?? '', requestId?.slice(0, 128) ?? randomUUID());
  }

  @Get()
  async list(@Headers('x-dev-user') user: string | undefined, @Query('mine') mine?: string,
    @Query('status') status?: string, @Query('page') page?: string, @Query('size') size?: string, @Headers('cookie') cookie?: string,
    @Query('queue') queue?: string): Promise<object> {
    if (mine && mine !== 'true' && mine !== 'false') throw new BadRequestException();
    return this.tickets.list(await this.tickets.identity({ devUser:user,cookie }), mine !== 'false', status, Number(page ?? 1), Number(size ?? 20), queue);
  }

  @Get(':id')
  async get(@Headers('x-dev-user') user: string | undefined, @Param('id') id: string, @Headers('cookie') cookie?: string): Promise<object> {
    return this.tickets.get(await this.tickets.identity({ devUser:user,cookie }), id);
  }

  @Get(':id/assignment-candidates')
  async candidates(@Headers('x-dev-user') user:string|undefined,@Param('id') id:string,
    @Query('groupId') group:string|undefined,@Headers('cookie') cookie?:string):Promise<object>{
    return this.tickets.assignmentCandidates(await this.tickets.identity({devUser:user,cookie}),id,group);
  }

  @Post(':id/actions')
  @HttpCode(200)
  async action(@Headers('x-dev-user') user: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Param('id') id: string, @Body() body: unknown,
    @Headers('cookie') cookie?: string, @Headers('x-csrf-token') csrf?: string): Promise<object> {
    return this.tickets.action(await this.tickets.identity({ devUser:user,cookie,csrf },true), id, body, key ?? '', requestId?.slice(0, 128) ?? randomUUID());
  }

  @Post(':id/feedback')
  @HttpCode(200)
  async feedback(@Headers('x-dev-user') user: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Param('id') id: string, @Body() body: unknown,
    @Headers('cookie') cookie?: string, @Headers('x-csrf-token') csrf?: string): Promise<object> {
    return this.tickets.feedback(await this.tickets.identity({ devUser:user,cookie,csrf },true), id, body, key ?? '', requestId?.slice(0,128) ?? randomUUID());
  }

  @Post(':id/priority-review')
  @HttpCode(200)
  async reviewPriority(@Headers('x-dev-user') user: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Param('id') id: string, @Body() body: unknown,
    @Headers('cookie') cookie?: string, @Headers('x-csrf-token') csrf?: string): Promise<object> {
    return this.tickets.reviewPriority(await this.tickets.identity({ devUser:user,cookie,csrf },true), id, body, key ?? '', requestId?.slice(0,128) ?? randomUUID());
  }

  @Post(':id/classification')
  @HttpCode(200)
  async classify(@Headers('x-dev-user') user:string|undefined,@Headers('idempotency-key') key:string|undefined,
    @Headers('x-request-id') requestId:string|undefined,@Param('id') id:string,@Body() body:unknown,
    @Headers('cookie') cookie?:string,@Headers('x-csrf-token') csrf?:string):Promise<object> {
    return this.tickets.classify(await this.tickets.identity({devUser:user,cookie,csrf},true),id,body,key??'',requestId?.slice(0,128)??randomUUID());
  }
}
