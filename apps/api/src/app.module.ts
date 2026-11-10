import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';
import { Database } from './database.service.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { WorkspaceController } from './workspace.controller.js';
import { SlaService } from './sla.service.js';
import { IntakePolicyService } from './intake-policy.service.js';
import { DelegationsController } from './delegations.controller.js';

@Module({ controllers: [HealthController, TicketsController,AuthController,WorkspaceController,DelegationsController], providers: [Database,AuthService,TicketsService,SlaService,IntakePolicyService] })
export class AppModule {}
