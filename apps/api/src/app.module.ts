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
import { ReportsController } from './reports.controller.js';
import { RolesController } from './roles.controller.js';
import { RolesService } from './roles.service.js';
import { RoutingConfigController } from './routing-config.controller.js';
import { RoutingConfigService } from './routing-config.service.js';
import { SupportController } from './support.controller.js';
import { SupportService } from './support.service.js';
import { ServiceStructureController } from './service-structure.controller.js';
import { ServiceStructureService } from './service-structure.service.js';
import { FulfillmentController } from './fulfillment.controller.js';
import { FulfillmentService } from './fulfillment.service.js';
import { DirectoryController } from './directory.controller.js';
import { VoiceAsrService } from './voice-asr.service.js';
import { IntakeInterpreterService } from './intake-interpreter.service.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

@Module({ controllers: [HealthController, TicketsController,AuthController,WorkspaceController,DelegationsController,RequestCatalogController,KnowledgeController,ReportsController,RolesController,RoutingConfigController,SupportController,ServiceStructureController,FulfillmentController,DirectoryController,AttachmentsController], providers: [Database,AuthService,TicketsService,SlaService,IntakePolicyService,RequestCatalogService,KnowledgeService,RolesService,RoutingConfigService,SupportService,ServiceStructureService,FulfillmentService,VoiceAsrService,IntakeInterpreterService,AttachmentsService] })
export class AppModule {}
