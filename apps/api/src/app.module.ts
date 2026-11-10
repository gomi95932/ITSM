import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';

@Module({ controllers: [HealthController, TicketsController], providers: [TicketsService] })
export class AppModule {}
