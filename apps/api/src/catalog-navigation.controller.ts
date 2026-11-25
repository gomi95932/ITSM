import {Body,Controller,Get,Headers,Post} from '@nestjs/common';
import {AuthService} from './auth.service.js';
import {CatalogNavigationService} from './catalog-navigation.service.js';
type H=Record<string,string|undefined>;
const auth=(h:H)=>({devUser:h['x-dev-user'],cookie:h.cookie,csrf:h['x-csrf-token']});
@Controller('admin/catalog-navigation')
export class CatalogNavigationController {
  constructor(private readonly identity:AuthService,private readonly navigation:CatalogNavigationService){}
  @Get() async list(@Headers() h:H){return this.navigation.list(await this.identity.identity(auth(h)));}
  @Post() async save(@Headers() h:H,@Body() body:unknown){return this.navigation.save(await this.identity.identity(auth(h),true),body);}
  @Get('tree') async tree(@Headers() h:H){return this.navigation.tree(await this.identity.identity(auth(h)));}
  @Post('tree/preview') async previewTree(@Headers() h:H,@Body() body:unknown){return this.navigation.previewTree(await this.identity.identity(auth(h),true),body);}
  @Post('tree') async saveTree(@Headers() h:H,@Body() body:unknown){return this.navigation.saveTree(await this.identity.identity(auth(h),true),body);}
}
