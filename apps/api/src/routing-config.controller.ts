import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { RoutingConfigService } from './routing-config.service.js';

type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/routing-config')
export class RoutingConfigController {
  constructor(private readonly identity:AuthService,private readonly routing:RoutingConfigService) {}
  @Get() async list(@Headers() h:H){return this.routing.list(await this.identity.identity(auth(h)));}
  @Get('triage') async triage(@Headers() h:H){return this.routing.triage(await this.identity.identity(auth(h)));}
  @Post('triage') @HttpCode(200) async saveTriage(@Headers() h:H,@Body() body:unknown){
    return this.routing.saveTriage(await this.identity.identity(auth(h),true),body);
  }
  @Post('triage/transfer') @HttpCode(200) async transferTriage(@Headers() h:H,@Body() body:unknown){
    return this.routing.transferTriage(await this.identity.identity(auth(h),true),body);
  }
  @Post('direct') @HttpCode(200) async direct(@Headers() h:H,@Body() body:unknown){
    return this.routing.propose(await this.identity.identity(auth(h),true),body,true);
  }
  @Get('automatic') async automatic(@Headers() h:H){return this.routing.automatic(await this.identity.identity(auth(h)));}
  @Post('automatic') @HttpCode(200) async saveAutomatic(@Headers() h:H,@Body() body:unknown){
    return this.routing.saveAutomatic(await this.identity.identity(auth(h),true),body);
  }
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.routing.history(await this.identity.identity(auth(h)),id);}
  @Post() async propose(@Headers() h:H,@Body() body:unknown){return this.routing.propose(await this.identity.identity(auth(h),true),body);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.routing.review(await this.identity.identity(auth(h),true),id,body);
  }
}
