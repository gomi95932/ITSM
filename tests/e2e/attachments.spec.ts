import { createHash,randomUUID } from 'node:crypto';
import { test,expect } from './fixtures';

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`attachment controls work without secure-context crypto on ${viewport.name}`,async({page})=>{
    const bytes=Buffer.from('Synthetic browser attachment fixture'),id=randomUUID();
    const created=await page.request.post('/api/v1/tickets',{headers:{'X-Dev-User':'employee-1','Idempotency-Key':randomUUID()},
      data:{serviceCode:'INC-BIZ',formVersion:1,subject:`E2E attachment ${id.slice(0,8)}`,description:'Disposable browser controls fixture',
        impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{},contentClass:'GENERAL'}});
    expect(created.status()).toBe(201);const ticket=await created.json() as {id:string};
    const path=`/api/v1/tickets/${ticket.id}/attachments`,items:Record<string,unknown>[]=[];
    let uploads=0;
    // HTTP/database and antivirus protocol boundaries have separate integration tests.
    await page.route(`**${path}**`,async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname===path&&request.method()==='GET')return route.fulfill({json:{items,enabled:true,configured:true,canUpload:true,canInternal:false,maxBytes:20971520}});
      if(url.pathname===`${path}/presign`){
        expect(request.postDataJSON()).toMatchObject({name:'fixture.txt',mime:'text/plain',size:bytes.length,
          sha256:createHash('sha256').update(bytes).digest('hex'),visibility:'PUBLIC',contentClass:'GENERAL'});
        return route.fulfill({status:201,json:{id,url:`${path}/${id}/content`,headers:{'Content-Type':'application/octet-stream','X-ITSM-Attachment-Expires':'fixture','X-ITSM-Attachment-Token':'fixture'}}});
      }
      if(url.pathname===`${path}/${id}/content`&&request.method()==='PUT'){
        expect(request.headers()['content-type']).toBe('application/octet-stream');
        expect(request.postDataBuffer()).toEqual(bytes);uploads++;
        items.push({id,name:'fixture.txt',mime:'text/plain',size:bytes.length,visibility:'PUBLIC',scanStatus:'CLEAN',createdAt:new Date().toISOString()});
        return route.fulfill({json:{id,scanStatus:'CLEAN'}});
      }
      if(url.pathname===`${path}/${id}/download`)return route.fulfill({json:{url:`${path}/${id}/content`,headers:{'X-ITSM-Attachment-Token':'fixture'}}});
      if(url.pathname===`${path}/${id}/content`)return route.fulfill({body:bytes,contentType:'text/plain'});
      throw new Error('UNEXPECTED_ATTACHMENT_BROWSER_REQUEST');
    });
    await page.addInitScript(()=>{sessionStorage.setItem('itsm-dev-user','employee-1');
      Object.defineProperty(Crypto.prototype,'subtle',{configurable:true,value:undefined});});
    await page.setViewportSize({width:viewport.width,height:viewport.height});await page.goto(`/#/tickets/${ticket.id}`);
    const section=page.getByRole('region',{name:'工单附件'});
    await expect(section.getByText('暂无附件',{exact:true})).toBeVisible();
    await section.getByLabel('添加附件').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:bytes});
    await expect(section.getByRole('button',{name:'上传附件',exact:true})).toBeDisabled();
    await section.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await section.getByRole('button',{name:'上传附件',exact:true}).click();
    await expect(section.getByText('附件已上传并通过扫描。',{exact:true})).toBeVisible();expect(uploads).toBe(1);
    await expect(section.getByText('fixture.txt',{exact:true})).toBeVisible();
    const download=page.waitForEvent('download');await section.getByRole('button',{name:'下载 fixture.txt',exact:true}).click();
    expect((await download).suggestedFilename()).toBe('fixture.txt');
    await page.screenshot({path:`test-results/attachments-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
