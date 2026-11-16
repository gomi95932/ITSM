import { Body,Controller,Get,Headers,HttpCode,Param,Post,Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { SupportService } from './support.service.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/support-structure')
export class SupportController {
  constructor(private readonly auth:AuthService,private readonly support:SupportService){}
  @Get() async list(@Headers() h:H){return this.support.list(await this.auth.identity(auth(h)));}
  @Get('people') async people(@Headers() h:H,@Query('q') q?:string){return this.support.people(await this.auth.identity(auth(h)),q);}
  @Get('groups/:group/members') async members(@Headers() h:H,@Param('group') group:string,@Query('q') q?:string,@Query('page') page?:string){
    return this.support.members(await this.auth.identity(auth(h)),group,q,page);
  }
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.support.history(await this.auth.identity(auth(h)),id);}
  @Post() async propose(@Headers() h:H,@Body() body:unknown){return this.support.propose(await this.auth.identity(auth(h),true),body);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.support.review(await this.auth.identity(auth(h),true),id,body);
  }
}
