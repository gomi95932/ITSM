import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { RolesService } from './roles.service.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/role-bindings')
export class RolesController {
  constructor(private readonly auth:AuthService,private readonly roles:RolesService) {}
  @Get() async list(@Headers() h:H){return this.roles.list(await this.auth.identity(auth(h)));}
  @Get('options') async options(@Headers() h:H,@Query('q') q?:string){return this.roles.options(await this.auth.identity(auth(h)),q);}
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.roles.history(await this.auth.identity(auth(h)),id);}
  @Post() async propose(@Headers() h:H,@Body() b:unknown){return this.roles.propose(await this.auth.identity(auth(h),true),b);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() b:unknown){return this.roles.decide(await this.auth.identity(auth(h),true),id,b);}
  @Post(':id/revoke') @HttpCode(200) async revoke(@Headers() h:H,@Param('id') id:string,@Body() b:unknown){return this.roles.decide(await this.auth.identity(auth(h),true),id,b,true);}
}
