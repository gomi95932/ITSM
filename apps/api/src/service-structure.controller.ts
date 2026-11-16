import { Body,Controller,Get,Headers,HttpCode,Param,Post,Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { ServiceStructureService } from './service-structure.service.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});

@Controller('admin/service-structure')
export class ServiceStructureController {
  constructor(private readonly auth:AuthService,private readonly structure:ServiceStructureService){}
  @Get() async list(@Headers() h:H){return this.structure.list(await this.auth.identity(auth(h)));}
  @Get('people') async people(@Headers() h:H,@Query('q') q?:string){return this.structure.people(await this.auth.identity(auth(h)),q);}
  @Get(':id/history') async history(@Headers() h:H,@Param('id') id:string){return this.structure.history(await this.auth.identity(auth(h)),id);}
  @Post('preview') @HttpCode(200) async preview(@Headers() h:H,@Body() body:unknown){return this.structure.preview(await this.auth.identity(auth(h),true),body);}
  @Post() async propose(@Headers() h:H,@Body() body:unknown){return this.structure.propose(await this.auth.identity(auth(h),true),body);}
  @Post(':id/review') @HttpCode(200) async review(@Headers() h:H,@Param('id') id:string,@Body() body:unknown){
    return this.structure.review(await this.auth.identity(auth(h),true),id,body);
  }
}
