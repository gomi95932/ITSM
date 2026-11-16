import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { RoutingConfigService } from './routing-config.service.js';

type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/routing-config')
export class RoutingConfigController {
  constructor(private readonly identity:AuthService,private readonly routing:RoutingConfigService) {}
  @Get() async list(@Headers() h:H){return this.routing.list(await this.identity.identity(auth(h)));}
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.routing.history(await this.identity.identity(auth(h)),id);}
  @Post() async propose(@Headers() h:H,@Body() body:unknown){return this.routing.propose(await this.identity.identity(auth(h),true),body);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.routing.review(await this.identity.identity(auth(h),true),id,body);
  }
}
