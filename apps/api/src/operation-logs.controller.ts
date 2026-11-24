import {Controller,Get,Headers,Param,Query} from '@nestjs/common';
import {AuthService} from './auth.service.js';
import {OperationLogsService} from './operation-logs.service.js';
type H=Record<string,string|undefined>;
@Controller('admin/operation-logs')
export class OperationLogsController {
  constructor(private readonly auth:AuthService,private readonly logs:OperationLogsService){}
  private identity(h:H){return this.auth.identity({devUser:h['x-dev-user'],cookie:h.cookie});}
  @Get() async list(@Headers() h:H,@Query() query:Record<string,unknown>){return this.logs.list(await this.identity(h),query);}
  @Get(':id') async detail(@Headers() h:H,@Param('id') id:string){return this.logs.detail(await this.identity(h),id);}
}
