import { Body,Controller,Get,Headers,HttpCode,Param,Post,Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { FulfillmentService } from './fulfillment.service.js';
type H=Record<string,string|undefined>;
const identity=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('fulfillments')
export class FulfillmentController {
  constructor(private readonly auth:AuthService,private readonly fulfillment:FulfillmentService){}
  @Get() async list(@Headers() h:H,@Query('queue') queue?:string,@Query('group') group?:string,@Query('page') page?:string){
    return this.fulfillment.list(await this.auth.identity(identity(h)),{queue,group,page});
  }
  @Get('intake') async intake(@Headers() h:H,@Query('group') group?:string,@Query('page') page?:string){
    return this.fulfillment.deliveryList(await this.auth.identity(identity(h)),{group,page});
  }
  @Post('intake/:id/prepare') @HttpCode(202) async prepare(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.fulfillment.enqueueDelivery(await this.auth.identity(identity(h),true),id,'PREPARE',body,h['idempotency-key']);
  }
  @Post('intake/:id/deliver') @HttpCode(202) async deliver(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.fulfillment.enqueueDelivery(await this.auth.identity(identity(h),true),id,'DELIVER',body,h['idempotency-key']);
  }
  @Get(':id') async detail(@Headers() h:H,@Param('id') id:string){return this.fulfillment.detail(await this.auth.identity(identity(h)),id);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.fulfillment.action(await this.auth.identity(identity(h),true),id,'REVIEW',body,h['idempotency-key']);
  }
  @Post(':id/revoke') @HttpCode(200) async revoke(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.fulfillment.action(await this.auth.identity(identity(h),true),id,'REVOKE',body,h['idempotency-key']);
  }
}
