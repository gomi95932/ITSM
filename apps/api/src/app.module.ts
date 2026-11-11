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
import { RequestCatalogController } from './request-catalog.controller.js';
import { RequestCatalogService } from './request-catalog.service.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';

@Module({ controllers: [HealthController, TicketsController,AuthController,WorkspaceController,DelegationsController,RequestCatalogController,KnowledgeController], providers: [Database,AuthService,TicketsService,SlaService,IntakePolicyService,RequestCatalogService,KnowledgeService] })
export class AppModule {}
