import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { SupportGroupsService } from './support-groups.service.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/support-groups')
export class SupportGroupsController {
  constructor(private readonly auth:AuthService,private readonly groups:SupportGroupsService) {}
  @Get() async list(@Headers() h:H){return this.groups.list(await this.auth.identity(auth(h)));}
  @Get('people') async people(@Headers() h:H,@Query('q') q?:string){return this.groups.people(await this.auth.identity(auth(h)),q);}
  @Get(':id') async detail(@Headers() h:H,@Param('id') id:string){return this.groups.detail(await this.auth.identity(auth(h)),id);}
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.groups.history(await this.auth.identity(auth(h)),id);}
  @Post() async create(@Headers() h:H,@Body() b:unknown){return this.groups.create(await this.auth.identity(auth(h),true),b);}
  @Patch(':id') async rename(@Headers() h:H,@Param('id') id:string,@Body() b:unknown){return this.groups.rename(await this.auth.identity(auth(h),true),id,b);}
  @Post(':id/members') async propose(@Headers() h:H,@Param('id') id:string,@Body() b:unknown){return this.groups.propose(await this.auth.identity(auth(h),true),id,b);}
  @Post(':id/members/:changeId/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Param('changeId') changeId:string,@Body() b:unknown){
    return this.groups.review(await this.auth.identity(auth(h),true),id,changeId,b);
  }
}
