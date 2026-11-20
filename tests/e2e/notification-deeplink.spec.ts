import { randomUUID } from 'node:crypto';
import { test,expect } from './fixtures';

for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
  test(`notification deep link requires current ticket permission and explicit processing on ${viewport.name}`,async({page})=>{
    const subject=`E2E notification link ${randomUUID().slice(0,8)}`;
    const created=await page.request.post('/api/v1/tickets',{
      headers:{'X-Dev-User':'employee-1','Idempotency-Key':randomUUID()},
      data:{serviceCode:'INC-BIZ',formVersion:1,subject,description:'Ordinary login issue for the disposable CI link test',
        impact:'INDIVIDUAL',urgency:'MEDIUM',fields:{},contentClass:'GENERAL'},
    });
    expect(created.status()).toBe(201);
    const ticket=await created.json() as {id:string};
    const target=`/#/tickets/${ticket.id}`;
    await page.addInitScript(()=>{if(!sessionStorage.getItem('itsm-dev-user'))sessionStorage.setItem('itsm-dev-user','agent-1');});
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    let writes=0;
    page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/v1/tickets'))writes++;});
    await page.goto(target);
    await expect(page.getByRole('heading',{name:subject,exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'接单并回复',exact:true})).toBeVisible();
    expect(writes).toBe(0);
    const before=await page.request.get(`/api/v1/tickets/${ticket.id}`,{headers:{'X-Dev-User':'employee-1'}});
    expect(await before.json()).toMatchObject({status:'QUEUED',version:1});
    await page.screenshot({path:`test-results/notification-deeplink-${viewport.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.getByRole('button',{name:'接单并回复',exact:true}).click();
    await page.getByRole('textbox',{name:'回复内容'}).fill('已从通知入口接单，正在排查');
    await page.getByRole('checkbox',{name:'本次内容不含密码、密钥及安全事件证据'}).check();
    await page.getByRole('button',{name:'接单并回复',exact:true}).last().click();
    await expect(page.locator('.ticket-meta')).toContainText('处理中');
    expect(writes).toBe(1);
    const processed=await page.request.get(`/api/v1/tickets/${ticket.id}`,{headers:{'X-Dev-User':'employee-1'}});
    expect(await processed.json()).toMatchObject({status:'IN_PROGRESS',version:2});
    await page.getByRole('combobox',{name:'开发身份'}).selectOption('employee-2');
    await expect(page.getByRole('heading',{name:'我的工单',exact:true})).toBeVisible();
    await page.goto(target);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading',{name:subject,exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'接单并回复',exact:true})).toHaveCount(0);
    const denied=await page.request.get(`/api/v1/tickets/${ticket.id}`,{headers:{'X-Dev-User':'employee-2'}});
    expect(denied.status()).toBe(404);expect(writes).toBe(1);
  });
}
