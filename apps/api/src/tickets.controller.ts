import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TicketsService } from './tickets.service.js';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  async create(@Headers('x-dev-user') user: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Body() body: unknown): Promise<object> {
    return this.tickets.create(await this.tickets.identity(user), body, key ?? '', requestId?.slice(0, 128) ?? randomUUID());
  }

  @Get()
  async list(@Headers('x-dev-user') user: string | undefined, @Query('mine') mine?: string,
    @Query('status') status?: string, @Query('page') page?: string, @Query('size') size?: string): Promise<object> {
    if (mine && mine !== 'true' && mine !== 'false') throw new BadRequestException();
    return this.tickets.list(await this.tickets.identity(user), mine !== 'false', status, Number(page ?? 1), Number(size ?? 20));
  }

  @Get(':id')
  async get(@Headers('x-dev-user') user: string | undefined, @Param('id') id: string): Promise<object> {
    return this.tickets.get(await this.tickets.identity(user), id);
  }

  @Post(':id/actions')
  @HttpCode(200)
  async action(@Headers('x-dev-user') user: string | undefined, @Headers('idempotency-key') key: string | undefined,
    @Headers('x-request-id') requestId: string | undefined, @Param('id') id: string, @Body() body: unknown): Promise<object> {
    return this.tickets.action(await this.tickets.identity(user), id, body, key ?? '', requestId?.slice(0, 128) ?? randomUUID());
  }
}
