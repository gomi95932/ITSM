import { Body,Controller,Get,Headers,HttpCode,Param,Post,Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { SupportService } from './support.service.js';
import { MemberPrivilegesService } from './member-privileges.service.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/support-structure')
export class SupportController {
  constructor(private readonly auth:AuthService,private readonly support:SupportService,private readonly privileges:MemberPrivilegesService){}
  @Get('groups/:group/members/:employee/privileges') async memberPrivileges(@Headers() h:H,@Param('group') group:string,@Param('employee') employee:string){
    return this.privileges.get(await this.auth.identity(auth(h)),group,employee);
  }
  @Post('groups/:group/members/:employee/privileges') @HttpCode(200) async saveMemberPrivileges(@Headers() h:H,@Param('group') group:string,@Param('employee') employee:string,@Body() body:unknown){
    return this.privileges.save(await this.auth.identity(auth(h),true),group,employee,body);
  }
  @Get() async list(@Headers() h:H){return this.support.list(await this.auth.identity(auth(h)));}
  @Get('people') async people(@Headers() h:H,@Query('q') q?:string){return this.support.people(await this.auth.identity(auth(h)),q);}
  @Get('groups/:group/members') async members(@Headers() h:H,@Param('group') group:string,@Query('q') q?:string,@Query('page') page?:string){
    return this.support.members(await this.auth.identity(auth(h)),group,q,page);
  }
  @Get('groups/:group/dependencies') async dependencies(@Headers() h:H,@Param('group') group:string){
    return this.support.dependencies(await this.auth.identity(auth(h)),group);
  }
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.support.history(await this.auth.identity(auth(h)),id);}
  @Post() async propose(@Headers() h:H,@Body() body:unknown){return this.support.propose(await this.auth.identity(auth(h),true),body);}
  @Post('apply') async apply(@Headers() h:H,@Body() body:unknown){return this.support.propose(await this.auth.identity(auth(h),true),body,true);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.support.review(await this.auth.identity(auth(h),true),id,body);
  }
}
